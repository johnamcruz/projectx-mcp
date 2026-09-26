import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ProjectXError, type ApiEnvelope, type ProjectXClient } from "./client.js";
import { publicConfig, type Config } from "./config.js";
import {
  BAR_UNITS,
  ORDER_TYPES,
  PLACEABLE_ORDER_TYPES,
  SIDES,
  decorateOrder,
  decoratePosition,
  decorateTrade,
} from "./enums.js";
import { JOURNAL_KINDS, Journal } from "./journal.js";
import { summarizeTrades, type Trade } from "./performance.js";
import type { QuoteSource } from "./realtime.js";
import {
  RiskError,
  assertDailyLoss,
  assertOrderSize,
  assertPositionLimit,
  assertSymbolAllowed,
  assertTradingAllowed,
  increasesExposure,
  realizedNet,
  tradingDayStart,
} from "./risk.js";

export interface Deps {
  config: Config;
  client: Pick<ProjectXClient, "post">;
  journal: Journal;
  marketHub: QuoteSource;
}

const INSTRUCTIONS = `ProjectX / TopstepX futures trading server. You are trading real (or evaluation) futures accounts on the user's behalf.
Workflow: get_server_config -> list_accounts -> search_contracts -> get_bars/get_quote -> journal_read (your past lessons) -> journal_add(kind "plan") -> place_order (with rationale) -> monitor via get_account_snapshot -> close/exit -> journal_add(kind "review" and "lesson").
Rules: always define the stop before entry; prefer micro contracts (MNQ, MES) while learning; never average down; flatten before the session closes unless the plan says otherwise; stop trading after hitting the daily loss limit.
Server-side guardrails (max order size, max position, daily loss, allowed accounts/symbols) may refuse orders; respect them, do not try to work around them.
Read the resource projectx://guide for the full operating guide.`;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function describeError(e: unknown): string {
  if (e instanceof RiskError) return `Blocked by risk guardrail: ${e.message}`;
  if (e instanceof ProjectXError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return failure(describeError(e));
    }
  };
}

const PLACE_ERRORS: Record<number, string> = {
  0: "Success", 1: "AccountNotFound", 2: "OrderRejected", 3: "InsufficientFunds", 4: "AccountViolation",
  5: "OutsideTradingHours", 6: "OrderPending", 7: "UnknownError", 8: "ContractNotFound", 9: "ContractNotActive",
  10: "AccountRejected",
};
// Modify shares the cancel endpoint's codes (the docs cite errorCode 3 = Rejected for bad trailPrice).
const ORDER_EDIT_ERRORS: Record<number, string> = {
  0: "Success", 1: "AccountNotFound", 2: "OrderNotFound", 3: "Rejected", 4: "Pending", 5: "UnknownError", 6: "AccountRejected",
};
const CLOSE_ERRORS: Record<number, string> = {
  0: "Success", 1: "AccountNotFound", 2: "PositionNotFound", 3: "ContractNotFound", 4: "ContractNotActive",
  5: "InvalidCloseSize", 6: "OrderRejected (market closed/halted or no price)", 7: "OrderPending", 8: "UnknownError",
  9: "AccountRejected",
};

function outcome(res: ApiEnvelope, names: Record<number, string>) {
  return {
    success: res.success,
    errorCode: res.errorCode,
    errorName: names[res.errorCode] ?? `Unknown(${res.errorCode})`,
    errorMessage: res.errorMessage,
  };
}

const UNIT_MS: Record<keyof typeof BAR_UNITS, number> = {
  second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 7 * 864e5, month: 31 * 864e5,
};

const accountId = z.number().int().describe("Trading account ID from list_accounts.");
const contractId = z.string().min(1).describe('Contract ID, e.g. "CON.F.US.MNQ.Z25". Get it from search_contracts.');
const isoTime = z.string().datetime({ offset: true });
const bracket = z
  .object({
    ticks: z.number().int().describe("Distance from the entry fill, in ticks."),
    type: z.enum(PLACEABLE_ORDER_TYPES).describe("Order type of the bracket leg, usually stop (for SL) or limit (for TP)."),
  })
  .optional();

export function createServer(deps: Deps): McpServer {
  const { config, client, journal, marketHub } = deps;
  const server = new McpServer({ name: "projectx-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const read = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

  async function openPositions(acct: number) {
    const res = await client.post<ApiEnvelope & { positions: Record<string, unknown>[] }>("/api/Position/searchOpen", {
      accountId: acct,
    });
    return res.positions.map(decoratePosition);
  }

  async function openOrders(acct: number) {
    const res = await client.post<ApiEnvelope & { orders: Record<string, unknown>[] }>("/api/Order/searchOpen", {
      accountId: acct,
    });
    return res.orders.map(decorateOrder);
  }

  async function trades(acct: number, start: string, end?: string): Promise<Trade[]> {
    const res = await client.post<ApiEnvelope & { trades: Trade[] }>("/api/Trade/search", {
      accountId: acct,
      startTimestamp: start,
      endTimestamp: end ?? null,
    });
    return res.trades;
  }

  // ── Session / config ────────────────────────────────────────────────

  server.registerTool(
    "get_server_config",
    {
      title: "Server config and guardrails",
      description:
        "Show whether trading is enabled and the risk guardrails this server enforces (max order size, max position, daily loss limit, allowed accounts/symbols). Call this first in every session.",
      annotations: read,
    },
    handler(async () => ({ ...publicConfig(config), tradingDayStartedAt: tradingDayStart().toISOString(), serverTime: new Date().toISOString() })),
  );

  // ── Accounts ────────────────────────────────────────────────────────

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description: "List trading accounts on this login with balance and canTrade flag.",
      inputSchema: { onlyActiveAccounts: z.boolean().default(true) },
      annotations: read,
    },
    handler(async ({ onlyActiveAccounts }: { onlyActiveAccounts: boolean }) => {
      const res = await client.post<ApiEnvelope & { accounts: Record<string, unknown>[] }>("/api/Account/search", { onlyActiveAccounts });
      return res.accounts.map((a) => ({
        ...a,
        mcpTradingAllowed: config.tradingEnabled && (!config.allowedAccountIds.length || config.allowedAccountIds.includes(a.id as number)),
      }));
    }),
  );

  server.registerTool(
    "get_account_snapshot",
    {
      title: "Account snapshot",
      description:
        "One-call view of an account: balance, open positions, working orders, and today's realized P&L (trading day starts 17:00 America/Chicago) versus the daily loss limit. Use this to monitor between decisions.",
      inputSchema: { accountId },
      annotations: read,
    },
    handler(async ({ accountId: acct }: { accountId: number }) => {
      const dayStart = tradingDayStart().toISOString();
      const [accounts, positions, orders, today] = await Promise.all([
        client.post<ApiEnvelope & { accounts: Record<string, unknown>[] }>("/api/Account/search", { onlyActiveAccounts: false }),
        openPositions(acct),
        openOrders(acct),
        trades(acct, dayStart),
      ]);
      const realized = realizedNet(today);
      return {
        account: accounts.accounts.find((a) => a.id === acct) ?? null,
        positions,
        openOrders: orders,
        today: {
          tradingDayStartedAt: dayStart,
          realizedNetPnL: Math.round(realized * 100) / 100,
          dailyLossLimit: config.maxDailyLoss || null,
          remainingBeforeLimit: config.maxDailyLoss ? Math.round((config.maxDailyLoss + realized) * 100) / 100 : null,
          ...summarizeTrades(today).overall,
        },
      };
    }),
  );

  // ── Market data ─────────────────────────────────────────────────────

  server.registerTool(
    "search_contracts",
    {
      title: "Search contracts",
      description:
        'Find tradable contracts by text, e.g. "MNQ", "ES", "CL". Returns up to 20 with id, tickSize, tickValue (USD per tick per contract) and activeContract. Trade the activeContract=true front month.',
      inputSchema: {
        searchText: z.string().min(1),
        live: z.boolean().default(false).describe("Use the live data subscription instead of sim. Usually false."),
      },
      annotations: read,
    },
    handler(async ({ searchText, live }: { searchText: string; live: boolean }) => {
      const res = await client.post<ApiEnvelope & { contracts: unknown[] }>("/api/Contract/search", { searchText, live });
      return res.contracts;
    }),
  );

  server.registerTool(
    "get_contract",
    {
      title: "Get contract",
      description: "Look up one contract by ID (tick size, tick value, whether it is the active month).",
      inputSchema: { contractId },
      annotations: read,
    },
    handler(async ({ contractId: id }: { contractId: string }) => {
      const res = await client.post<ApiEnvelope & { contract: unknown }>("/api/Contract/searchById", { contractId: id });
      return res.contract;
    }),
  );

  server.registerTool(
    "list_available_contracts",
    {
      title: "List available contracts",
      description: "List every contract available to trade. Large output; prefer search_contracts when you know the symbol.",
      inputSchema: { live: z.boolean().default(false) },
      annotations: read,
    },
    handler(async ({ live }: { live: boolean }) => {
      const res = await client.post<ApiEnvelope & { contracts: unknown[] }>("/api/Contract/available", { live });
      return res.contracts;
    }),
  );

  server.registerTool(
    "get_bars",
    {
      title: "Historical bars",
      description:
        "OHLCV bars for a contract, returned oldest→newest. t=bar open time (UTC), o/h/l/c=prices, v=volume. " +
        "Defaults: endTime=now, startTime chosen to cover `limit` bars. Max 20,000 bars; rate limit 50 requests / 30s.",
      inputSchema: {
        contractId,
        unit: z.enum(Object.keys(BAR_UNITS) as [keyof typeof BAR_UNITS]).default("minute"),
        unitNumber: z.number().int().positive().default(5).describe("Bar size in units, e.g. unit=minute unitNumber=5 → 5-minute bars."),
        limit: z.number().int().positive().max(20000).default(100),
        startTime: isoTime.optional(),
        endTime: isoTime.optional(),
        includePartialBar: z.boolean().default(false),
        live: z.boolean().default(false),
      },
      annotations: read,
    },
    handler(async (a: {
      contractId: string;
      unit: keyof typeof BAR_UNITS;
      unitNumber: number;
      limit: number;
      startTime?: string;
      endTime?: string;
      includePartialBar: boolean;
      live: boolean;
    }) => {
      const end = a.endTime ? new Date(a.endTime) : new Date();
      // 2x the span plus 4 days so weekends and overnight gaps still yield `limit` bars.
      const span = UNIT_MS[a.unit] * a.unitNumber * a.limit * 2 + 4 * 864e5;
      const start = a.startTime ? new Date(a.startTime) : new Date(end.getTime() - span);
      const res = await client.post<ApiEnvelope & { bars: Array<{ t: string }> }>("/api/History/retrieveBars", {
        contractId: a.contractId,
        live: a.live,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        unit: BAR_UNITS[a.unit],
        unitNumber: a.unitNumber,
        limit: a.limit,
        includePartialBar: a.includePartialBar,
      });
      const bars = [...res.bars].sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
      return { contractId: a.contractId, barSize: `${a.unitNumber} ${a.unit}`, count: bars.length, bars };
    }),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Live quote",
      description:
        "Latest real-time quote (lastPrice, bestBid, bestAsk, session open/high/low, volume) from the market hub. Returns null quote if none arrives within the timeout (e.g. market closed).",
      inputSchema: { contractId, timeoutMs: z.number().int().min(500).max(15000).default(5000) },
      annotations: read,
    },
    handler(async ({ contractId: id, timeoutMs }: { contractId: string; timeoutMs: number }) => {
      const hit = await marketHub.getQuote(id, timeoutMs);
      return hit
        ? { contractId: id, ageMs: hit.ageMs, quote: hit.quote }
        : { contractId: id, quote: null, note: "No quote received. The market may be closed; use get_bars for the last prices." };
    }),
  );

  // ── Orders, positions, trades (read) ────────────────────────────────

  server.registerTool(
    "list_open_orders",
    {
      title: "Open orders",
      description: "Working orders on an account (includes bracket stop/target legs).",
      inputSchema: { accountId },
      annotations: read,
    },
    handler(async ({ accountId: acct }: { accountId: number }) => openOrders(acct)),
  );

  server.registerTool(
    "search_orders",
    {
      title: "Order history",
      description: "Orders created in a time window (any status). For trailing stops, trailPrice here is the trail distance in price, not a level.",
      inputSchema: { accountId, startTimestamp: isoTime, endTimestamp: isoTime.optional() },
      annotations: read,
    },
    handler(async (a: { accountId: number; startTimestamp: string; endTimestamp?: string }) => {
      const res = await client.post<ApiEnvelope & { orders: Record<string, unknown>[] }>("/api/Order/search", {
        accountId: a.accountId,
        startTimestamp: a.startTimestamp,
        endTimestamp: a.endTimestamp ?? null,
      });
      return res.orders.map(decorateOrder);
    }),
  );

  server.registerTool(
    "list_open_positions",
    {
      title: "Open positions",
      description: "Open positions on an account. direction is long/short; averagePrice is the entry.",
      inputSchema: { accountId },
      annotations: read,
    },
    handler(async ({ accountId: acct }: { accountId: number }) => openPositions(acct)),
  );

  server.registerTool(
    "search_trades",
    {
      title: "Fill history",
      description:
        "Fills in a time window. profitAndLoss is null on the opening half of a round turn (halfTurn=true) and set on the closing fill. Defaults to the current trading day.",
      inputSchema: { accountId, startTimestamp: isoTime.optional(), endTimestamp: isoTime.optional() },
      annotations: read,
    },
    handler(async (a: { accountId: number; startTimestamp?: string; endTimestamp?: string }) =>
      (await trades(a.accountId, a.startTimestamp ?? tradingDayStart().toISOString(), a.endTimestamp)).map((t) =>
        decorateTrade(t as unknown as Record<string, unknown>),
      ),
    ),
  );

  server.registerTool(
    "get_performance",
    {
      title: "Performance statistics",
      description:
        "Win rate, net P&L after fees, average win/loss, profit factor, expectancy, overall and per contract, for a time window (default: current trading day). Use it to grade your own trading.",
      inputSchema: { accountId, startTimestamp: isoTime.optional(), endTimestamp: isoTime.optional() },
      annotations: read,
    },
    handler(async (a: { accountId: number; startTimestamp?: string; endTimestamp?: string }) => {
      const start = a.startTimestamp ?? tradingDayStart().toISOString();
      return { window: { start, end: a.endTimestamp ?? "now" }, ...summarizeTrades(await trades(a.accountId, start, a.endTimestamp)) };
    }),
  );

  // ── Trading (write) ─────────────────────────────────────────────────

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Submit an order. side: buy|sell. type: market | limit (needs limitPrice) | stop (needs stopPrice) | trailing_stop (needs trailPrice = absolute price level, NOT a distance) | join_bid | join_ask. " +
        "Brackets (stopLossBracket/takeProfitBracket, in ticks) only work if the account uses Auto OCO Brackets; otherwise place a separate stop order after the fill. " +
        "Server guardrails may block the order. `rationale` is required and saved to the journal so you can learn from the outcome.",
      inputSchema: {
        accountId,
        contractId,
        side: z.enum(["buy", "sell"]),
        type: z.enum(PLACEABLE_ORDER_TYPES),
        size: z.number().int().positive(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trailPrice: z.number().positive().optional(),
        stopLossBracket: bracket,
        takeProfitBracket: bracket,
        customTag: z.string().max(100).optional().describe("Must be unique across the account."),
        rationale: z
          .string()
          .min(20)
          .describe("Why this trade: setup, invalidation (where the stop is and why), target, and expected risk in $."),
      },
      annotations: write,
    },
    async (a: {
      accountId: number;
      contractId: string;
      side: "buy" | "sell";
      type: (typeof PLACEABLE_ORDER_TYPES)[number];
      size: number;
      limitPrice?: number;
      stopPrice?: number;
      trailPrice?: number;
      stopLossBracket?: { ticks: number; type: (typeof PLACEABLE_ORDER_TYPES)[number] };
      takeProfitBracket?: { ticks: number; type: (typeof PLACEABLE_ORDER_TYPES)[number] };
      customTag?: string;
      rationale: string;
    }) => {
      try {
        if (a.type === "limit" && a.limitPrice === undefined) throw new RiskError("limit orders require limitPrice.");
        if (a.type === "stop" && a.stopPrice === undefined) throw new RiskError("stop orders require stopPrice.");
        if (a.type === "trailing_stop" && a.trailPrice === undefined) throw new RiskError("trailing_stop orders require trailPrice.");

        assertTradingAllowed(config, a.accountId);
        assertSymbolAllowed(config, a.contractId);
        assertOrderSize(config, a.size);

        const [positions, orders] = await Promise.all([openPositions(a.accountId), openOrders(a.accountId)]);
        const currentNet = positions
          .filter((p) => p.contractId === a.contractId)
          .reduce((n, p) => n + (p.type === 1 ? 1 : p.type === 2 ? -1 : 0) * (p.size as number), 0);
        const entryTypes: number[] = [ORDER_TYPES.limit, ORDER_TYPES.join_bid, ORDER_TYPES.join_ask];
        const pendingSameSide = orders
          .filter((o) => o.contractId === a.contractId && o.side === SIDES[a.side] && entryTypes.includes(o.type as number))
          .reduce((n, o) => n + (o.size as number), 0);
        const exposure = { currentNet, pendingSameSide, side: a.side, size: a.size };

        if (increasesExposure(exposure)) {
          if (config.maxDailyLoss > 0) {
            assertDailyLoss(config, realizedNet(await trades(a.accountId, tradingDayStart().toISOString())));
          }
          assertPositionLimit(config, exposure);
        }

        const res = await client.post<ApiEnvelope & { orderId: number | null }>(
          "/api/Order/place",
          {
            accountId: a.accountId,
            contractId: a.contractId,
            type: ORDER_TYPES[a.type],
            side: SIDES[a.side],
            size: a.size,
            limitPrice: a.limitPrice ?? null,
            stopPrice: a.stopPrice ?? null,
            trailPrice: a.trailPrice ?? null,
            customTag: a.customTag ?? null,
            stopLossBracket: a.stopLossBracket ? { ticks: a.stopLossBracket.ticks, type: ORDER_TYPES[a.stopLossBracket.type] } : null,
            takeProfitBracket: a.takeProfitBracket
              ? { ticks: a.takeProfitBracket.ticks, type: ORDER_TYPES[a.takeProfitBracket.type] }
              : null,
          },
          { allowFailure: true },
        );
        const result = { orderId: res.orderId, ...outcome(res, PLACE_ERRORS) };
        await journal.add({
          kind: "order_placed",
          text: a.rationale,
          accountId: a.accountId,
          contractId: a.contractId,
          orderId: res.orderId ?? undefined,
          data: { request: { side: a.side, type: a.type, size: a.size, limitPrice: a.limitPrice, stopPrice: a.stopPrice, trailPrice: a.trailPrice, stopLossBracket: a.stopLossBracket, takeProfitBracket: a.takeProfitBracket }, result, positionBefore: currentNet },
        });
        return res.success ? json(result) : { ...json(result), isError: true };
      } catch (e) {
        if (e instanceof RiskError) {
          await journal
            .add({ kind: "order_blocked", text: `${e.message} | rationale: ${a.rationale}`, accountId: a.accountId, contractId: a.contractId })
            .catch(() => {});
        }
        return failure(describeError(e));
      }
    },
  );

  server.registerTool(
    "modify_order",
    {
      title: "Modify order",
      description:
        "Change size or price of a working order (e.g. move a stop to breakeven). trailPrice is an absolute price level; unlike place_order there is no max-distance check, so double-check it.",
      inputSchema: {
        accountId,
        orderId: z.number().int(),
        size: z.number().int().positive().optional(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trailPrice: z.number().positive().optional(),
        reason: z.string().optional().describe("Why; saved to the journal."),
      },
      annotations: write,
    },
    handler(async (a: { accountId: number; orderId: number; size?: number; limitPrice?: number; stopPrice?: number; trailPrice?: number; reason?: string }) => {
      assertTradingAllowed(config, a.accountId);
      if (a.size !== undefined) assertOrderSize(config, a.size);
      const res = await client.post<ApiEnvelope>(
        "/api/Order/modify",
        {
          accountId: a.accountId,
          orderId: a.orderId,
          size: a.size ?? null,
          limitPrice: a.limitPrice ?? null,
          stopPrice: a.stopPrice ?? null,
          trailPrice: a.trailPrice ?? null,
        },
        { allowFailure: true },
      );
      if (a.reason) await journal.add({ kind: "note", text: `modify order ${a.orderId}: ${a.reason}`, accountId: a.accountId, orderId: a.orderId });
      return outcome(res, ORDER_EDIT_ERRORS);
    }),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel a working order. Simulated (non-follower) accounts only.",
      inputSchema: { accountId, orderId: z.number().int() },
      annotations: write,
    },
    handler(async (a: { accountId: number; orderId: number }) => {
      assertTradingAllowed(config, a.accountId);
      return outcome(await client.post<ApiEnvelope>("/api/Order/cancel", a, { allowFailure: true }), ORDER_EDIT_ERRORS);
    }),
  );

  server.registerTool(
    "close_position",
    {
      title: "Close position",
      description:
        "Flatten the whole position in a contract at market. Does NOT cancel resting stop/target orders; check list_open_orders and cancel leftovers.",
      inputSchema: { accountId, contractId, reason: z.string().optional().describe("Why; saved to the journal.") },
      annotations: write,
    },
    handler(async (a: { accountId: number; contractId: string; reason?: string }) => {
      assertTradingAllowed(config, a.accountId);
      const res = await client.post<ApiEnvelope>(
        "/api/Position/closeContract",
        { accountId: a.accountId, contractId: a.contractId },
        { allowFailure: true },
      );
      await journal.add({ kind: "exit", text: a.reason ?? "close_position", accountId: a.accountId, contractId: a.contractId, data: outcome(res, CLOSE_ERRORS) });
      return outcome(res, CLOSE_ERRORS);
    }),
  );

  server.registerTool(
    "partial_close_position",
    {
      title: "Partially close position",
      description: "Close part of a position at market (scale out).",
      inputSchema: { accountId, contractId, size: z.number().int().positive(), reason: z.string().optional() },
      annotations: write,
    },
    handler(async (a: { accountId: number; contractId: string; size: number; reason?: string }) => {
      assertTradingAllowed(config, a.accountId);
      const res = await client.post<ApiEnvelope>(
        "/api/Position/partialCloseContract",
        { accountId: a.accountId, contractId: a.contractId, size: a.size },
        { allowFailure: true },
      );
      await journal.add({ kind: "exit", text: a.reason ?? `partial close ${a.size}`, accountId: a.accountId, contractId: a.contractId, data: outcome(res, CLOSE_ERRORS) });
      return outcome(res, CLOSE_ERRORS);
    }),
  );

  // ── Learning journal ────────────────────────────────────────────────

  server.registerTool(
    "journal_add",
    {
      title: "Write to trading journal",
      description:
        "Persist your reasoning so future sessions can learn from it. kinds: plan (pre-session thesis), entry, exit, review (post-trade grading: what happened vs. plan), lesson (a durable rule you want future-you to follow), note.",
      inputSchema: {
        kind: z.enum(["plan", "entry", "exit", "review", "lesson", "note"]),
        text: z.string().min(1),
        accountId: accountId.optional(),
        contractId: contractId.optional(),
        orderId: z.number().int().optional(),
        tags: z.array(z.string()).optional().describe('Free-form, e.g. ["breakout", "MNQ", "mistake:chased"].'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler(async (a: { kind: (typeof JOURNAL_KINDS)[number]; text: string; accountId?: number; contractId?: string; orderId?: number; tags?: string[] }) =>
      journal.add(a),
    ),
  );

  server.registerTool(
    "journal_read",
    {
      title: "Read trading journal",
      description:
        'Read past journal entries (newest last). Start each session with journal_read({kind:"lesson"}) and recent reviews so you do not repeat mistakes.',
      inputSchema: {
        kind: z.enum(JOURNAL_KINDS).optional(),
        tag: z.string().optional(),
        contractId: contractId.optional(),
        since: isoTime.optional(),
        limit: z.number().int().positive().max(500).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(async (q: { kind?: (typeof JOURNAL_KINDS)[number]; tag?: string; contractId?: string; since?: string; limit: number }) => journal.read(q)),
  );

  // ── Guide resource & session prompt ─────────────────────────────────

  const guideUrl = new URL("../AGENTS.md", import.meta.url);
  server.registerResource(
    "guide",
    "projectx://guide",
    { title: "Trading agent operating guide", description: "How to use these tools to trade and learn.", mimeType: "text/markdown" },
    async (uri) => {
      let text: string;
      try {
        text = readFileSync(guideUrl, "utf8");
      } catch {
        text = INSTRUCTIONS;
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerPrompt(
    "trading_session",
    {
      title: "Start a trading session",
      description: "Kick off a disciplined trading session: review lessons, plan, trade within guardrails, review.",
      argsSchema: { focus: z.string().optional().describe("Contract or setup to focus on, e.g. MNQ opening range.") },
    },
    ({ focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Run a trading session${focus ? ` focused on ${focus}` : ""}. Read projectx://guide first. ` +
              "Then: get_server_config; list_accounts; journal_read lessons and recent reviews; build a written plan (journal_add kind=plan) " +
              "with setup, entry trigger, stop, target, size, and max $ risk; only then trade. After each exit write a review, and end the session with at least one lesson.",
          },
        },
      ],
    }),
  );

  return server;
}
