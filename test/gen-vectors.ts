/**
 * Writes vectors/*.json: the scenarios below, replayed through today's code,
 * with each call's result stored as its `expect`. Run it only when a
 * deliberate change to the live computation is approved:
 *   npx tsx test/gen-vectors.ts
 * test/vectors.test.ts then checks the code still reproduces every file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOM_TYPE } from "../src/orderflow.js";
import { VECTOR_SCHEMA, runVector, type Vector, type VectorStep } from "./vectors.js";

const M = 60_000;
/** 2026-10-12 17:00 America/Chicago (CDT): a trading-day start. */
const S = Date.UTC(2026, 9, 12, 22, 0);
const NQ = "CON.F.US.ENQ.Z26";
const MNQ = "CON.F.US.MNQ.Z26";
const iso = (t: number) => new Date(t).toISOString();

/** Builds a scenario's steps on one receive clock. */
class Scenario {
  readonly steps: VectorStep[] = [];
  /** The quote feed's session volume, raised by every sided or sideless print pushed. */
  private vol = 1000;
  private last = 100;
  constructor(public t: number, private readonly id = NQ) {}

  call(tool: string, args: Record<string, unknown>) {
    this.steps.push({ at: this.t, call: { tool, args } });
    return this;
  }
  /** GatewayTrade items: [exchange time, price, size, type]. */
  trades(items: Array<[number, number, number, number | null]>, opts: { countVolume?: boolean } = {}) {
    const payload = items.map(([t, price, volume, type]) => ({ symbolId: "F.US.ENQ", price, volume, ...(type === null ? {} : { type }), timestamp: iso(t) }));
    if (opts.countVolume ?? true) for (const [, price, v] of items) {
      this.vol += v;
      this.last = price;
    }
    this.steps.push({ at: this.t, hub: "trade", contractId: this.id, payload });
    return this;
  }
  /** GatewayDepth items: [type, price, volume]; the exchange timestamp is the receive time. */
  depth(items: Array<[number, number, number]>) {
    this.steps.push({ at: this.t, hub: "depth", contractId: this.id, payload: items.map(([type, price, volume]) => ({ type, price, volume, currentVolume: volume, timestamp: iso(this.t) })) });
    return this;
  }
  quote(extra: Record<string, unknown> = {}) {
    this.steps.push({ at: this.t, hub: "quote", contractId: this.id, payload: { symbol: "F.US.ENQ", lastPrice: this.last, volume: this.vol, timestamp: iso(this.t), ...extra } });
    return this;
  }
  tick() {
    this.steps.push({ at: this.t, tick: true });
    return this;
  }
  down() {
    this.steps.push({ at: this.t, hub: "down" });
    return this;
  }
  resubscribe() {
    for (const kind of ["trades", "depth", "quotes"] as const) this.steps.push({ at: this.t, hub: "resubscribed", kind, contractId: this.id });
    return this;
  }
  /** Session volume the trade feed never delivers (a dead or lagging trade subscription). */
  unprinted(contracts: number) {
    this.vol += contracts;
    return this;
  }
  /** Bars History/retrieveBars returns from now on (open times). */
  restBars(times: number[]) {
    this.steps.push({ at: this.t, restBars: times.map((t) => ({ t: iso(t), o: 100, h: 100.5, l: 99.75, c: 100, v: 1 })) });
    return this;
  }
  at(t: number) {
    this.t = t;
    return this;
  }
  /** A live market: a quote every `step` ms and a maintenance pass, up to `until`. */
  pump(until: number, step = 2_000, quote = true) {
    while (this.t < until) {
      this.t = Math.min(until, this.t + step);
      if (quote) this.quote();
      this.tick();
    }
    return this;
  }
}

function vector(name: string, description: string, sc: Scenario, o: Partial<Pick<Vector, "env" | "tickSize">> = {}): Vector {
  return { schema: VECTOR_SCHEMA, name, description, env: o.env ?? {}, tickSize: o.tickSize ?? 0.25, steps: sc.steps };
}

/** Trade side from the exchange flag, and every per-minute trade field. */
function tradeFields(): Vector {
  const sc = new Scenario(S + 2 * M + 10_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 1 });
  sc.pump(S + 3 * M + 2_000);
  // type 0 = buy aggressor, 1 = sell aggressor; anything else (here 4, and a missing type) has no side.
  sc.trades([[S + 3 * M + 1_000, 100, 12, 0], [S + 3 * M + 1_500, 100.25, 3, 0], [S + 3 * M + 2_000, 99.75, 10, 1], [S + 3 * M + 2_000, 99.5, 1, 1]]);
  sc.pump(S + 4 * M + 2_000);
  sc.trades([[S + 4 * M + 1_000, 100, 2, 0], [S + 4 * M + 1_200, 100, 5, 4], [S + 4 * M + 1_300, 100.25, 1, null]]);
  sc.pump(S + 5 * M + 2_000);
  sc.trades([[S + 5 * M + 1_000, 99.75, 4, 1]]);
  sc.pump(S + 6 * M + 2_000);
  // A trade after the minute's end + 2 s settles it early.
  sc.trades([[S + 6 * M + 1_000, 100, 1, 0]]);
  sc.pump(S + 6 * M + 12_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 5 });
  sc.call("get_order_flow", { contractId: NQ, minutes: 5, largePrint: 3 });
  sc.call("get_trades", { contractId: NQ, limit: 20 });
  return vector(
    "trade-fields",
    "bv/sv from the GatewayTrade type flag (0 buy, 1 sell, else sideless), delta, volume, trades, vwap, high, low, maxPrint, large prints at two thresholds, ofiTrades; a sideless print makes its minute incomplete.",
    sc,
  );
}

/** Quote OFI and book imbalance from the L2 book, timed by receive time. */
function bookFields(): Vector {
  const sc = new Scenario(S + 2 * M + 10_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 1 });
  sc.pump(S + 3 * M);
  sc.depth([[DOM_TYPE.Reset, 0, 0], [DOM_TYPE.Bid, 99.75, 10], [DOM_TYPE.Bid, 99.5, 20], [DOM_TYPE.Ask, 100, 5], [DOM_TYPE.Ask, 100.25, 15]]);
  sc.pump(S + 3 * M + 15_000);
  sc.depth([[DOM_TYPE.Bid, 99.75, 14]]); // bid size up: +14 - 10
  sc.pump(S + 3 * M + 30_000);
  sc.depth([[DOM_TYPE.Ask, 100, 2]]); // ask size down: -2 + 5
  sc.pump(S + 3 * M + 45_000);
  sc.depth([[DOM_TYPE.NewBestBid, 100, 3], [DOM_TYPE.BestAsk, 100.25, 15]]); // bid up a tick; ask 100 removed, best ask 100.25
  sc.pump(S + 3 * M + 50_000);
  sc.depth([[DOM_TYPE.Trade, 100.25, 1], [DOM_TYPE.Fill, 100.25, 1], [DOM_TYPE.Low, 99, 0], [DOM_TYPE.High, 101, 0]]); // ignored by the book
  sc.pump(S + 3 * M + 55_000);
  sc.depth([[DOM_TYPE.Ask, 100.25, 0]]); // the only ask empties: the book stays valid (both sides were seen) with no asks
  sc.pump(S + 4 * M + 30_000);
  sc.depth([[DOM_TYPE.Ask, 100.5, 8]]);
  sc.pump(S + 5 * M + 12_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 3 });
  sc.call("get_market_depth", { contractId: NQ, levels: 5, imbalanceLevels: 2, history: 50 });
  sc.call("get_top_of_book", { contractId: NQ, history: 50 });
  return vector(
    "book-fields",
    "ofiQuote (Cont-Kukanov-Stoikov on the L2 book's best levels, per depth message) and bookImbalance (top-5 L2 levels, time-weighted over receive time while the book is valid), the L2 book rules (Reset, Best/NewBest clearing levels through the price, size 0 removing, Trade/Fill/Low/High ignored).",
    sc,
  );
}

/** Completeness: partial first minute, silence, trade-feed mismatch, disconnect, late print, bad timestamp. */
function completeness(): Vector {
  const sc = new Scenario(S + 2 * M + 10_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 1 });
  sc.pump(S + 4 * M + 12_000);
  // A silence over 10 s: no message from +12 s to +40 s.
  sc.at(S + 4 * M + 40_000).quote().tick();
  sc.pump(S + 6 * M);
  // The quote feed's session volume rises with no print: the trade feed missed it.
  sc.at(S + 6 * M + 5_000).unprinted(50).quote().tick();
  sc.pump(S + 7 * M + 12_000);
  // A print with an unusable timestamp (no offset): counted at the receive time and makes its minute incomplete.
  sc.steps.push({ at: sc.t, hub: "trade", contractId: NQ, payload: [{ price: 100, volume: 1, type: 0, timestamp: "2026-10-12T22:07:12" }] });
  sc.pump(S + 9 * M + 12_000);
  // A late print for a minute already final: counted, never applied.
  sc.trades([[S + 8 * M + 30_000, 100, 7, 0]], { countVolume: false });
  sc.pump(S + 10 * M);
  // A disconnect and resubscribe: the minutes it touches are incomplete; replayed prints from before the resubscribe are ignored.
  sc.at(S + 10 * M + 20_000).down().tick();
  sc.at(S + 11 * M + 10_000).resubscribe();
  sc.trades([[S + 10 * M + 15_000, 100, 9, 0]], { countVolume: false });
  sc.pump(S + 14 * M + 12_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 13 });
  return vector(
    "completeness",
    "complete=false for the first partial minute, a minute touched by a silence over 10 s, a minute whose quote volume rose with no print (tradeFeedMismatch), a minute with a bad-timestamp print, and minutes around a disconnect; late and replayed prints are counted, not applied.",
    sc,
  );
}

/** Bars, windows, footprint, book fields on bars, and the session cumulative delta. */
function barsAndSession(): Vector {
  const sc = new Scenario(S - 2 * M);
  sc.call("get_order_flow", { contractId: NQ, minutes: 1 });
  sc.pump(S + 10_000);
  // Depth messages in the middle of minutes: the book is defined for 30 s of the first minute, and its
  // imbalance changes mid-minute, so a bar's plain mean of minute means differs from a time-weighted mean.
  const depth: Array<[number, Array<[number, number, number]>]> = [
    [S + 30_000, [[DOM_TYPE.Reset, 0, 0], [DOM_TYPE.Bid, 99.75, 10], [DOM_TYPE.Ask, 100, 5]]],
    [S + M + 40_000, [[DOM_TYPE.Bid, 99.75, 20]]],
    [S + 3 * M + 10_000, [[DOM_TYPE.Ask, 100, 25]]],
  ];
  const prints: Array<[number, number, number, number]> = [
    [S + 5_000, 100, 4, 0],
    [S + M + 5_000, 100.25, 9, 0],
    [S + M + 6_000, 100, 2, 1],
    [S + 2 * M + 5_000, 100, 1, 0],
    [S + 3 * M + 5_000, 99.75, 6, 1],
    [S + 4 * M + 5_000, 99.75, 12, 1],
    [S + 5 * M + 5_000, 100, 3, 0],
    [S + 7 * M + 5_000, 100.5, 11, 0],
    [S + 8 * M + 5_000, 100.25, 2, 1],
  ];
  const events = [...depth.map(([t, d]) => ({ t, run: () => sc.depth(d) })), ...prints.map((p) => ({ t: p[0] + 1_000, run: () => sc.trades([p]) }))].sort((a, b) => a.t - b.t);
  for (const e of events) {
    sc.pump(e.t);
    e.run();
  }
  sc.pump(S + 10 * M + 12_000);
  sc.call("get_order_flow", { contractId: NQ, minutes: 12 });
  sc.call("get_footprint", { contractId: NQ, barMinutes: 5, bars: 3, imbalanceRatio: 3 });
  // 5-minute MNQ bars (NQ's flow); the last returned bar is complete, and the 3-bar window of each reaches before the first bar.
  sc.restBars([S - 5 * M, S, S + 5 * M]);
  sc.call("get_bars", { contractId: MNQ, unit: "minute", unitNumber: 5, limit: 3, includeOrderFlow: true, flowWindows: [2, 3] });
  // 1-minute bars: S+6m is quiet but complete (vwap and ofiTrade null); the 3-bar window of S+5m needs S+3m and S+4m, before the first returned bar.
  sc.restBars([S + 5 * M, S + 6 * M]);
  sc.call("get_bars", { contractId: NQ, unit: "minute", unitNumber: 1, limit: 2, includeOrderFlow: true, flowWindows: [1, 3] });
  // A quiet hour (quotes every 8 s), then hour bars: the 17:00 CT hour is complete.
  sc.pump(S + 62 * M + 12_000, 8_000);
  sc.restBars([S - 60 * M, S]);
  sc.call("get_bars", { contractId: MNQ, unit: "hour", unitNumber: 1, limit: 2, includeOrderFlow: true, flowWindows: [1, 2] });
  return vector(
    "bars-and-session",
    "get_footprint bars (volume at price, POC, imbalance flags with tick 0.25); get_bars includeOrderFlow: MNQ bars carry NQ's flow, 5-minute bars with 2- and 3-bar windows reaching before the first bar, ofiQuote and the plain mean of minute bookImbalance on bars, a quiet complete 1-minute bar, hour bars; and the session cumulative delta from the 17:00 CT trading-day start.",
    sc,
  );
}

async function main() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
  mkdirSync(dir, { recursive: true });
  for (const v of [tradeFields(), bookFields(), completeness(), barsAndSession()]) {
    const results = await runVector(v);
    let i = 0;
    for (const s of v.steps) if ("call" in s) s.expect = results[i++];
    writeFileSync(join(dir, `${v.name}.json`), `${JSON.stringify(v, null, 1)}\n`);
    process.stderr.write(`wrote vectors/${v.name}.json (${v.steps.length} steps)\n`);
  }
}

void main();
