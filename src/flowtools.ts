/**
 * The read-only order-flow tools: get_order_flow, get_footprint, get_trades,
 * get_market_depth (L2) and get_top_of_book (L1). They serve the in-process
 * live feed (subscribed on the first call for a contract); get_order_flow and
 * get_footprint also merge the recorder's complete minutes when
 * PROJECTX_FLOW_DIR is set. MCP servers never write flow files.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { FLOW_LIMITS, type FlowFeed } from "./flowfeed.js";
import { readRecorded, readRecordedCsv } from "./flowstore.js";
import {
  EMPTY_BAR_FLOW,
  MINUTE_MS,
  barFlow,
  cumulativeDeltas,
  flowWindow,
  footprintBar,
  gapsOf,
  mergeRecords,
  minuteOf,
  rowOf,
  type BarFlow,
  type MinuteRecord,
} from "./orderflow.js";
import { tradingDayStart } from "./risk.js";
import { handler } from "./tooling.js";

export const MAX_DEPTH_LEVELS = 200;

const DATA_STARTS =
  "Data starts when this server subscribed to the contract (on the first order-flow call for it); nothing before that exists unless the flow recorder wrote it.";
const COMPLETE =
  "complete=true means: the trade subscription was confirmed before the minute started and stayed connected through its end; the minute settled (a trade after its end + 2 s, or 10-20 s passed); " +
  "hub messages kept arriving with no silence over 10 s; the quote feed's volume and last price agree with the prints (a quiet minute needs flat quote volume); " +
  "and every print had a usable timestamp and a known side. Use a bar only when all its minutes are complete.";
const LIVE_ONLY = "Live only: from this server's own subscription, never from recorded files.";

const contractId = z.string().min(1).describe('Contract ID, e.g. "CON.F.US.MNQ.Z25". Get it from search_contracts.');

export interface FlowToolDeps {
  config: Config;
  flow?: FlowFeed;
  now: () => number;
  warn: (line: string) => void;
}

/**
 * Micro contracts whose bars carry the full-size contract's order flow (same
 * expiry): micro and mini are treated the same, so MNQ bars carry NQ's flow and
 * MES bars ES's. ProjectX names NQ `ENQ` and ES `EP` in its contract ids
 * (CON.F.US.ENQ.Z26, CON.F.US.EP.Z26), UNVERIFIED against the live contract
 * list; an id the broker does not know is refused by the contract check and the
 * bars get no flow.
 */
export const FLOW_SOURCE_ROOT: Readonly<Record<string, string>> = Object.freeze({ MNQ: "ENQ", MES: "EP" });

/** The contract whose order flow a contract's bars carry: the full-size contract for a listed micro, else itself. */
export function flowSourceContract(contractId: string): string {
  const parts = contractId.split(".");
  const src = parts.length >= 5 ? FLOW_SOURCE_ROOT[parts[3].toUpperCase()] : undefined;
  if (!src) return contractId;
  parts[3] = src;
  return parts.join(".");
}

/** get_bars waits at most this long for a first flow subscription (the contract check is bounded separately). */
export const BARS_FLOW_WAIT_MS = 1_000;
/** The order-flow part of get_bars (contract check, subscribe, recorded read) adds at most this; then the bars get empty flow. */
export const BARS_FLOW_BUDGET_MS = 3_000;

export type BarWithFlow<B> = B & { flow: BarFlow & { windows: Record<string, { ofiTrade: number | null; delta: number | null }> } };

/**
 * get_bars' opt-in order flow: each bar [t, t + span) gets the sum of its
 * minute rows (barFlow), plus trade OFI and delta over the last n spans for
 * each n in `windows`. The minutes are the live rows merged with the
 * recorder's complete minutes, exactly as get_order_flow builds them, for the
 * flow source contract (MNQ uses NQ). Only minute and hour bars carry flow.
 * Never throws: when the flow is unavailable every bar gets empty flow and
 * `orderFlow.note` says why.
 */
export async function barsWithFlow<B extends { t: string }>(
  d: FlowToolDeps,
  contractId: string,
  bars: B[],
  unit: string,
  unitNumber: number,
  windows: number[],
  budgetMs = BARS_FLOW_BUDGET_MS,
): Promise<{ bars: Array<BarWithFlow<B>>; orderFlow: Record<string, unknown> }> {
  const source = flowSourceContract(contractId);
  const lp = d.config.flowLargePrint;
  const info = { sourceContractId: source, largePrint: lp, windows };
  const noWindows = () => Object.fromEntries(windows.map((n) => [String(n), { ofiTrade: null, delta: null }]));
  const plain = (note: string) => ({ bars: bars.map((b) => ({ ...b, flow: { ...EMPTY_BAR_FLOW, windows: noWindows() } })), orderFlow: { ...info, note } });
  const minutes = unit === "minute" ? unitNumber : unit === "hour" ? unitNumber * 60 : null;
  if (minutes === null) return plain("Order flow is built from minutes: only minute and hour bars carry it.");
  if (!d.flow) return plain("Order flow is not available on this server.");
  const flow = d.flow;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), budgetMs);
    timer.unref?.();
  });
  const work = (async () => {
    try {
      await flow.ensure(source, BARS_FLOW_WAIT_MS, { dropLateRefusal: true });
    } catch (e) {
      return plain(`Order flow unavailable for ${source}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return await withFlow(d, flow, source, info, plain, bars, minutes, windows);
    } catch (e) {
      return plain(`Order flow for ${source} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  // A late answer is dropped: its reads finish in the background and change nothing.
  const res = await Promise.race([work, late]).finally(() => clearTimeout(timer));
  return res ?? plain(`Order flow for ${source} took longer than ${budgetMs} ms; the bars come without it.`);
}

async function withFlow<B extends { t: string }>(
  d: FlowToolDeps,
  flow: FlowFeed,
  source: string,
  info: Record<string, unknown>,
  plain: (note: string) => { bars: Array<BarWithFlow<B>>; orderFlow: Record<string, unknown> },
  bars: B[],
  minutes: number,
  windows: number[],
): Promise<{ bars: Array<BarWithFlow<B>>; orderFlow: Record<string, unknown> }> {
  const lp = d.config.flowLargePrint;
  const span = minutes * MINUTE_MS;
  const starts = bars.map((b) => Date.parse(b.t)).filter(Number.isFinite);
  if (!starts.length) return plain("No bar has a usable time.");
  const deepest = Math.max(1, ...windows);
  const from = Math.min(...starts) - (deepest - 1) * span;
  const to = Math.max(...starts) + span - MINUTE_MS;
  const { byMinute, recorded } = await mergedMinutes(d, flow, source, from, to);
  const memo = new Map<number, BarFlow>();
  const spanFlow = (start: number) => {
    let f = memo.get(start);
    if (!f) memo.set(start, (f = barFlow(byMinute, start, minutes, lp)));
    return f;
  };
  const out = bars.map((b) => {
    // A time that does not parse (NaN) finds no minutes: empty flow and null windows.
    const start = Date.parse(b.t);
    return { ...b, flow: { ...spanFlow(start), windows: Object.fromEntries(windows.map((n) => [String(n), flowWindow(spanFlow, start, span, n)])) } };
  });
  return { bars: out, orderFlow: { ...info, recorded, note: `${COMPLETE} ${DATA_STARTS}` } };
}

/** Live records for [from, to], merged with the recorder's complete minutes (JSONL, this window only) when PROJECTX_FLOW_DIR is set. */
async function mergedMinutes(d: FlowToolDeps, flow: FlowFeed, id: string, from: number, to: number) {
  const live = flow.records(id, from, to);
  const rec = d.config.flowDir ? await readRecorded(d.config.flowDir, id, from, to) : null;
  if (rec?.error) d.warn(`order flow: reading recorded flow for ${id} failed: ${rec.error}`);
  const byMinute = mergeRecords(live, rec?.records ?? []);
  const recorded = rec ? { rows: rec.records.length, truncated: rec.truncated, error: rec.error } : "off (PROJECTX_FLOW_DIR not set)";
  return { byMinute, recorded };
}

export function registerFlowTools(server: McpServer, d: FlowToolDeps): void {
  const read = { readOnlyHint: true, openWorldHint: true } as const;

  /** The feed, subscribed for this contract (within the cap). */
  async function feedFor(id: string): Promise<FlowFeed> {
    if (!d.flow) throw new Error("Order flow is not available on this server.");
    // Over the contract cap this throws a FlowCapError naming the subscribed contracts.
    await d.flow.ensure(id);
    return d.flow;
  }

  const merged = (flow: FlowFeed, id: string, from: number, to: number) => mergedMinutes(d, flow, id, from, to);

  /**
   * Buy/sell volume per minute from the session start up to `before`, for the
   * cumulative delta: live minutes plus the recorder's small CSV rows (not the JSONL).
   */
  async function sessionMinutes(flow: FlowFeed, id: string, sessionFrom: number, before: number): Promise<MinuteRecord[]> {
    if (sessionFrom >= before) return [];
    const live = flow.records(id, sessionFrom, before - MINUTE_MS);
    if (!d.config.flowDir) return live;
    const csv = await readRecordedCsv(d.config.flowDir, id, sessionFrom, before - MINUTE_MS);
    return [...mergeRecords(live, csv.records).values()];
  }

  /** Coverage of the merged minutes in [from, to]: where data starts and the incomplete runs after it. */
  function coverage(flow: FlowFeed, id: string, byMinute: Map<number, MinuteRecord>, from: number, to: number, recorded: unknown) {
    const inWindow = [...byMinute.keys()].filter((t) => t >= from && t <= to).sort((a, b) => a - b);
    const since = inWindow[0] ?? null;
    // Minutes not settled yet (the current one, or one inside this contract's grace) are not gaps.
    const live = flow.coverage(id);
    const lastFinal = live.decidedThrough === null ? -Infinity : Date.parse(live.decidedThrough);
    const recordedUpTo = Math.max(-Infinity, ...[...byMinute.values()].filter((r) => r.source === "recorded").map((r) => r.t));
    const end = Math.min(to, Math.max(lastFinal, recordedUpTo));
    return {
      since: since === null ? null : new Date(since).toISOString(),
      gaps: since === null || end < since ? [] : gapsOf(byMinute, since, end),
      live,
      recorded,
      note: DATA_STARTS,
    };
  }

  server.registerTool(
    "get_order_flow",
    {
      title: "Order flow per minute",
      description:
        "Per-minute order flow (UTC minutes, oldest first): bv/sv = aggressor buy/sell volume, delta, volume, trades, vwap, high, low, maxPrint, " +
        "largeBuyVolume/largeSellVolume (prints of at least `largePrint` contracts), ofiTrades=(bv-sv)/(bv+sv), ofiQuote (Cont-Kukanov best bid/ask order-flow imbalance), " +
        "bookImbalance (time-averaged top-5 L2 imbalance), cumDelta (session cumulative delta from 17:00 CT; null after any unknown minute), and source (live or recorded). " +
        `${COMPLETE} ${DATA_STARTS}`,
      inputSchema: {
        contractId,
        minutes: z.number().int().min(1).max(1440).default(30),
        largePrint: z.number().int().positive().optional().describe("Large-print threshold in contracts (default PROJECTX_FLOW_LARGE_PRINT, 10)."),
      },
      annotations: read,
    },
    handler(async ({ contractId: id, minutes, largePrint }: { contractId: string; minutes: number; largePrint?: number }) => {
      const flow = await feedFor(id);
      const cur = minuteOf(d.now());
      const from = cur - (minutes - 1) * MINUTE_MS;
      // Cumulative delta needs every minute since the session started.
      const sessionFrom = Math.min(from, tradingDayStart(new Date(from)).getTime());
      const { byMinute, recorded } = await merged(flow, id, from, cur);
      const all = new Map(byMinute);
      for (const r of await sessionMinutes(flow, id, sessionFrom, from)) all.set(r.t, r);
      const cum = cumulativeDeltas(all, sessionFrom, cur);
      const lp = largePrint ?? d.config.flowLargePrint;
      const rows = [...byMinute.values()]
        .sort((a, b) => a.t - b.t)
        .map((r) => rowOf(r, lp, cum.get(r.t) ?? null));
      const lastComplete = [...rows].reverse().find((r) => r.complete);
      const value = lastComplete?.cumDelta ?? null;
      return {
        contractId: id,
        largePrint: lp,
        rows,
        cumulativeDelta: {
          value,
          asOf: lastComplete?.t ?? null,
          sessionStart: tradingDayStart(new Date(d.now())).toISOString(),
          ...(value === null ? { note: "Unknown: not every minute since the session start (17:00 CT) is complete in live or recorded data." } : {}),
        },
        coverage: coverage(flow, id, byMinute, from, cur, recorded),
      };
    }),
  );

  server.registerTool(
    "get_footprint",
    {
      title: "Footprint bars",
      description:
        "Footprint bars of `barMinutes` (aligned to UTC), oldest first: per price bidVolume (sell aggressor) and askVolume (buy aggressor), POC, bar delta and volume, " +
        "and imbalance flags: buyImbalance when askVolume(P) >= imbalanceRatio x bidVolume(P - 1 tick), sellImbalance when bidVolume(P) >= imbalanceRatio x askVolume(P + 1 tick) (zero denominators never flag). " +
        `A bar is complete only when all its minutes are. ${COMPLETE} ${DATA_STARTS}`,
      inputSchema: {
        contractId,
        barMinutes: z.number().int().min(1).max(240).default(5),
        bars: z.number().int().min(1).max(100).default(10),
        imbalanceRatio: z.number().min(1).max(100).default(3),
      },
      annotations: read,
    },
    handler(async ({ contractId: id, barMinutes, bars, imbalanceRatio }: { contractId: string; barMinutes: number; bars: number; imbalanceRatio: number }) => {
      const flow = await feedFor(id);
      const barMs = barMinutes * MINUTE_MS;
      const cur = minuteOf(d.now());
      const lastBar = Math.floor(cur / barMs) * barMs;
      const firstBar = lastBar - (bars - 1) * barMs;
      const { byMinute, recorded } = await merged(flow, id, firstBar, cur);
      const tick = await flow.tickSize(id);
      const out = [];
      for (let b = firstBar; b <= lastBar; b += barMs) {
        const minutes = Array.from({ length: barMinutes }, (_, k) => byMinute.get(b + k * MINUTE_MS));
        if (minutes.every((r) => !r)) continue;
        out.push(footprintBar(b, barMinutes, minutes, tick, imbalanceRatio));
      }
      return {
        contractId: id,
        barMinutes,
        tickSize: tick,
        imbalanceRatio,
        ...(tick === null ? { note: "Tick size unknown: imbalance flags are null." } : {}),
        bars: out,
        coverage: coverage(flow, id, byMinute, firstBar, cur, recorded),
      };
    }),
  );

  server.registerTool(
    "get_trades",
    {
      title: "Recent prints (time and sales)",
      description:
        `Recent prints, oldest first: t (exchange time, UTC), price, size, side (aggressor: buy lifted the ask, sell hit the bid; null if unknown). Up to ${FLOW_LIMITS.prints} kept per contract. ${LIVE_ONLY} ${DATA_STARTS}`,
      inputSchema: {
        contractId,
        limit: z.number().int().min(1).max(1000).default(100),
        since: z.string().datetime({ offset: true }).optional(),
      },
      annotations: read,
    },
    handler(async ({ contractId: id, limit, since }: { contractId: string; limit: number; since?: string }) => {
      const flow = await feedFor(id);
      const prints = flow.prints(id, { limit, since: since ? Date.parse(since) : undefined });
      return {
        contractId: id,
        count: prints.length,
        prints: prints.map((p) => ({ t: new Date(p.t).toISOString(), price: p.price, size: p.size, side: p.side })),
        coverage: { live: flow.coverage(id), note: `${LIVE_ONLY} ${DATA_STARTS}` },
      };
    }),
  );

  server.registerTool(
    "get_market_depth",
    {
      title: "L2 market depth",
      description:
        `L2: the maintained order book, best first per side: {price, size, cumSize} up to \`levels\` (at most ${MAX_DEPTH_LEVELS} per side), best bid/ask, spread in ticks, ` +
        "imbalance (bid-ask)/(bid+ask) over `imbalanceLevels`, the book's age since its last depth update, `valid` (both sides arrived since the last reset or reconnect), " +
        "`partial` (only one side so far: levels shown, no imbalance) and `snapshot` (it was rebuilt after a Reset). `history` returns that many recent per-level changes (adds and pulls: size and prevSize at a price; side null marks a reset). " +
        `${LIVE_ONLY} ${DATA_STARTS}`,
      inputSchema: {
        contractId,
        levels: z.number().int().min(1).max(MAX_DEPTH_LEVELS).default(10),
        imbalanceLevels: z.number().int().min(1).max(50).default(5),
        history: z.number().int().min(1).max(FLOW_LIMITS.depthChanges).optional(),
      },
      annotations: read,
    },
    handler(async ({ contractId: id, levels, imbalanceLevels, history }: { contractId: string; levels: number; imbalanceLevels: number; history?: number }) => {
      const flow = await feedFor(id);
      return { ...(await flow.depth(id, { levels, imbalanceLevels, history })), coverage: { live: flow.coverage(id), note: `${LIVE_ONLY} ${DATA_STARTS}` } };
    }),
  );

  server.registerTool(
    "get_top_of_book",
    {
      title: "L1 top of book",
      description:
        "L1: best bid and best ask with their sizes, the last trade (price, size, aggressor side), spread in ticks and mid, each with its time, age and source. " +
        "Bid/ask come from the L2 book (source depth) and fall back to the quote feed (source quote, no size) when there is no valid book; the last trade comes from the prints. " +
        `\`history\` returns that many recent best bid/ask changes (up to ${FLOW_LIMITS.l1Events} kept; quote OFI is computed from them). ${LIVE_ONLY} ${DATA_STARTS}`,
      inputSchema: { contractId, history: z.number().int().min(1).max(FLOW_LIMITS.l1Events).optional() },
      annotations: read,
    },
    handler(async ({ contractId: id, history }: { contractId: string; history?: number }) => {
      const flow = await feedFor(id);
      return { ...(await flow.topOfBook(id, history)), coverage: { live: flow.coverage(id), note: `${LIVE_ONLY} ${DATA_STARTS}` } };
    }),
  );
}
