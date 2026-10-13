import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlowFeed, SUBSCRIBE_WAIT_MS, TICK_LOOKUP_MS, VALIDATE_MS } from "../src/flowfeed.js";
import { FlowWriter } from "../src/flowstore.js";
import { MAX_DEPTH_LEVELS } from "../src/flowtools.js";
import { DOM_TYPE, MINUTE_MS, addPrint, newBucket, recordOf } from "../src/orderflow.js";
import { fakeClock, fakeFlowHub, setup } from "./helpers.js";

const S = Date.UTC(2026, 9, 12, 22, 0); // 17:00 CT session start
const C = "CON.F.US.MNQ.Z26";
const iso = (t: number) => new Date(t).toISOString();
const trade = (t: number, price: number, volume: number, type: number) => ({ price, volume, type, timestamp: iso(t) });

async function flowSetup(o: { start?: number; dir?: string; maxContracts?: number; noFlow?: boolean; subscribeWaitMs?: number } = {}) {
  const hub = fakeFlowHub();
  const clock = fakeClock(o.start ?? S + 2 * MINUTE_MS + 10_000);
  const flow = new FlowFeed({ hub, now: clock.now, ticks: { get: async () => 0.25 }, warn: () => {}, maxContracts: o.maxContracts, subscribeWaitMs: o.subscribeWaitMs, timers: { every: () => 1, cancel: () => {} } });
  const env: Record<string, string> = o.dir ? { PROJECTX_FLOW_DIR: o.dir } : {};
  const s = await setup({ clock, env, deps: o.noFlow ? {} : { flow } });
  // The quote feed's session volume follows the prints the test pushes, so quiet minutes are genuinely quiet.
  const vol = new Map<string, number>();
  const pushTrade = hub.trade;
  hub.trade = (id: string, data: unknown) => {
    for (const it of Array.isArray(data) ? data : [data]) {
      if (it && typeof (it as any).volume === "number" && [0, 1].includes((it as any).type)) vol.set(id, (vol.get(id) ?? 1000) + (it as any).volume);
    }
    pushTrade(id, data);
  };
  /** A busy market: a quote every `step` ms and a maintenance pass. */
  const pump = async (until: number, step = 2_000) => {
    while (clock.t < until) {
      clock.t = Math.min(until, clock.t + step);
      for (const id of flow.contracts()) hub.quote(id, { lastPrice: 100, volume: vol.get(id) ?? 1000 });
      await flow.tick();
    }
  };
  return { ...s, hub, flow, clock, pump };
}

function writeRecorded(dir: string, minutes: Array<[number, number, number]>) {
  const w = new FlowWriter(dir, 10, () => {});
  for (const [t, bv, sv] of minutes) {
    const b = newBucket(t);
    if (bv) addPrint(b, { t, price: 100, size: bv, side: "buy" });
    if (sv) addPrint(b, { t, price: 99.75, size: sv, side: "sell" });
    w.write(C, recordOf(b, true));
  }
}

describe("order-flow tools (MCP mode)", () => {
  it("subscribe lazily on the first call, never at startup, and write no files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxft-"));
    const { call, hub, clock } = await flowSetup({ dir });
    expect(hub.calls).toEqual([]);
    const first = await call("get_order_flow", { contractId: C });
    expect(first.isError).toBe(false);
    expect(hub.subscribes()).toEqual([`trades:${C}`, `depth:${C}`, `quotes:${C}`]);
    expect(first.data.coverage).toMatchObject({ since: iso(S + 2 * MINUTE_MS), gaps: [], recorded: { rows: 0, truncated: false, error: null } });
    expect(first.data.coverage.live).toMatchObject({ subscribedAt: iso(clock.t), liveSince: iso(clock.t) });
    expect(first.data.coverage.note).toMatch(/Data starts when this server subscribed/);
    hub.trade(C, [trade(S + 3 * MINUTE_MS + 1_000, 100, 4, 0)]);
    clock.t = S + 4 * MINUTE_MS + 5_000;
    await call("get_footprint", { contractId: C, barMinutes: 1, bars: 3 });
    await call("get_trades", { contractId: C });
    await call("get_market_depth", { contractId: C });
    await call("get_top_of_book", { contractId: C });
    expect(hub.subscribes()).toHaveLength(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("get_order_flow: rows, large prints, completeness, cumulative delta unknown without the session start", async () => {
    const { call, hub, pump } = await flowSetup();
    await call("get_order_flow", { contractId: C });
    await pump(S + 3 * MINUTE_MS + 2_000);
    hub.trade(C, [trade(S + 3 * MINUTE_MS + 1_000, 100, 12, 0), trade(S + 3 * MINUTE_MS + 2_000, 99.75, 3, 1)]);
    await pump(S + 5 * MINUTE_MS + 5_000);
    // The minute that just ended has not settled (no trade after it, settle grace 10 s): not a gap yet.
    const early = await call("get_order_flow", { contractId: C, minutes: 10 });
    expect(early.data.coverage.gaps).toEqual([{ from: iso(S + 2 * MINUTE_MS), to: iso(S + 3 * MINUTE_MS), minutes: 1 }]);
    await pump(S + 5 * MINUTE_MS + 12_000);
    const res = await call("get_order_flow", { contractId: C, minutes: 3, largePrint: 5 });
    expect(res.data.rows.map((r: any) => [r.t, r.complete, r.bv, r.sv, r.source])).toEqual([
      [iso(S + 3 * MINUTE_MS), true, 12, 3, "live"],
      [iso(S + 4 * MINUTE_MS), true, 0, 0, "live"],
      [iso(S + 5 * MINUTE_MS), false, 0, 0, "live"],
    ]);
    expect(res.data.rows[0]).toMatchObject({ delta: 9, largeBuyVolume: 12, largeSellVolume: 0, ofiTrades: 9 / 15, cumDelta: null });
    expect(res.data.largePrint).toBe(5);
    expect(res.data.cumulativeDelta).toMatchObject({ value: null, asOf: iso(S + 4 * MINUTE_MS), sessionStart: iso(S) });
    expect(res.data.cumulativeDelta.note).toMatch(/Unknown/);
    // The first partial minute is a gap.
    const all = await call("get_order_flow", { contractId: C, minutes: 10 });
    expect(all.data.coverage.gaps).toEqual([{ from: iso(S + 2 * MINUTE_MS), to: iso(S + 3 * MINUTE_MS), minutes: 1 }]);
    expect(all.data.largePrint).toBe(10);
    expect((await call("get_order_flow", { contractId: C, minutes: 1441 })).isError).toBe(true);
    expect((await call("get_order_flow", { contractId: C, minutes: 0 })).isError).toBe(true);
  });

  it("merges the recorder's complete minutes, preferring them over incomplete live ones and marking the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxft-"));
    // The last row is from a recorder whose clock runs ahead: beyond the window, never shown.
    writeRecorded(dir, [[S, 5, 1], [S + MINUTE_MS, 2, 2], [S + 2 * MINUTE_MS, 7, 0], [S + 10 * MINUTE_MS, 1, 0]]);
    const { call, hub, pump } = await flowSetup({ dir });
    await call("get_order_flow", { contractId: C });
    await pump(S + 2 * MINUTE_MS + 20_000);
    hub.trade(C, trade(S + 2 * MINUTE_MS + 20_000, 100, 1, 0));
    await pump(S + 3 * MINUTE_MS + 2_000);
    hub.trade(C, trade(S + 3 * MINUTE_MS + 1_000, 100, 3, 1));
    await pump(S + 4 * MINUTE_MS + 12_000);
    const res = await call("get_order_flow", { contractId: C, minutes: 5 });
    expect(res.data.rows.map((r: any) => [r.t, r.source, r.complete, r.bv, r.sv, r.cumDelta])).toEqual([
      [iso(S), "recorded", true, 5, 1, 4],
      [iso(S + MINUTE_MS), "recorded", true, 2, 2, 4],
      [iso(S + 2 * MINUTE_MS), "recorded", true, 7, 0, 11],
      [iso(S + 3 * MINUTE_MS), "live", true, 0, 3, 8],
      [iso(S + 4 * MINUTE_MS), "live", false, 0, 0, null],
    ]);
    expect(res.data.cumulativeDelta).toMatchObject({ value: 8, asOf: iso(S + 3 * MINUTE_MS) });
    expect(res.data.coverage).toMatchObject({ since: iso(S), gaps: [], recorded: { rows: 3 } });
    const fp = await call("get_footprint", { contractId: C, barMinutes: 2, bars: 3 });
    expect(fp.data.bars.map((b: any) => [b.t, b.complete, b.volume, b.delta, b.sources.sort()])).toEqual([
      [iso(S), true, 10, 4, ["recorded"]],
      [iso(S + 2 * MINUTE_MS), true, 10, 4, ["live", "recorded"]],
      [iso(S + 4 * MINUTE_MS), false, 0, 0, ["live"]],
    ]);
  });

  it("cumulative delta before the window comes from the recorder's CSV rows, not the JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxft-"));
    // Only the CSV has the early minutes (the JSONL tail read stays inside the window).
    writeFileSync(join(dir, `${C}.csv`), `${iso(S)},5,1\n${iso(S + MINUTE_MS)},2,2\n${iso(S + 2 * MINUTE_MS)},7,0\n`);
    const { call, hub, pump } = await flowSetup({ dir });
    await call("get_order_flow", { contractId: C });
    await pump(S + 3 * MINUTE_MS + 2_000);
    hub.trade(C, trade(S + 3 * MINUTE_MS + 1_000, 100, 3, 1));
    await pump(S + 4 * MINUTE_MS + 12_000);
    const res = await call("get_order_flow", { contractId: C, minutes: 2 });
    expect(res.data.rows.map((r: any) => [r.t, r.cumDelta])).toEqual([
      [iso(S + 3 * MINUTE_MS), 8],
      [iso(S + 4 * MINUTE_MS), null],
    ]);
    expect(res.data.cumulativeDelta.value).toBe(8);
    expect(res.data.coverage.recorded).toMatchObject({ rows: 0 });
  });

  it("get_footprint: volume at price, POC, imbalance flags and limits", async () => {
    const { call, hub, pump } = await flowSetup();
    await call("get_footprint", { contractId: C });
    const t = S + 3 * MINUTE_MS;
    await pump(t + 4_000);
    hub.trade(C, [trade(t + 1_000, 100.25, 9, 0), trade(t + 2_000, 100, 2, 1), trade(t + 3_000, 100, 1, 0), trade(t + 4_000, 99.75, 6, 1)]);
    await pump(S + 4 * MINUTE_MS + 12_000);
    const res = await call("get_footprint", { contractId: C, barMinutes: 1, bars: 2 });
    expect(res.data).toMatchObject({ barMinutes: 1, tickSize: 0.25, imbalanceRatio: 3 });
    const bar = res.data.bars[0];
    expect(bar).toMatchObject({ t: iso(t), complete: true, poc: 100.25, volume: 18, delta: 2 });
    expect(bar.levels).toEqual([
      { price: 100.25, bidVolume: 0, askVolume: 9, buyImbalance: true, sellImbalance: false },
      { price: 100, bidVolume: 2, askVolume: 1, buyImbalance: false, sellImbalance: false },
      { price: 99.75, bidVolume: 6, askVolume: 0, buyImbalance: false, sellImbalance: true },
    ]);
    expect(res.data.bars[1]).toMatchObject({ complete: false });
    expect((await call("get_footprint", { contractId: C, bars: 101 })).isError).toBe(true);
    expect((await call("get_footprint", { contractId: C, barMinutes: 0 })).isError).toBe(true);
  });

  it("get_trades: recent prints with limit and since, live only", async () => {
    const { call, hub } = await flowSetup();
    await call("get_trades", { contractId: C });
    const t = S + 2 * MINUTE_MS + 20_000;
    hub.trade(C, [trade(t, 100, 1, 0), trade(t + 1, 100.25, 2, 1), trade(t + 2, 100.5, 3, 4)]);
    const res = await call("get_trades", { contractId: C, limit: 2 });
    expect(res.data).toMatchObject({ contractId: C, count: 2 });
    expect(res.data.prints).toEqual([{ t: iso(t + 1), price: 100.25, size: 2, side: "sell" }, { t: iso(t + 2), price: 100.5, size: 3, side: null }]);
    expect(res.data.coverage.note).toMatch(/Live only/);
    expect((await call("get_trades", { contractId: C, since: iso(t + 2) })).data.count).toBe(1);
    expect((await call("get_trades", { contractId: C, limit: 1001 })).isError).toBe(true);
  });

  it("get_market_depth (L2): levels, history, limits", async () => {
    const { call, hub } = await flowSetup();
    await call("get_market_depth", { contractId: C });
    hub.depth(C, [
      { type: DOM_TYPE.Bid, price: 100, volume: 5, timestamp: iso(S) },
      { type: DOM_TYPE.Ask, price: 100.25, volume: 2, timestamp: iso(S) },
    ]);
    const res = await call("get_market_depth", { contractId: C, levels: MAX_DEPTH_LEVELS, history: 5 });
    expect(res.data).toMatchObject({ valid: true, spreadTicks: 1, bids: [{ price: 100, size: 5, cumSize: 5 }], asks: [{ price: 100.25, size: 2, cumSize: 2 }] });
    expect(res.data.history).toHaveLength(2);
    expect(res.data.coverage.note).toMatch(/Live only/);
    expect((await call("get_market_depth", { contractId: C, levels: MAX_DEPTH_LEVELS + 1 })).isError).toBe(true);
    expect((await call("get_market_depth", { contractId: C, history: 20_001 })).isError).toBe(true);
    expect(MAX_DEPTH_LEVELS).toBe(200);
  });

  it("get_top_of_book (L1): quote fallback, then depth, with history and limits", async () => {
    const { call, hub } = await flowSetup();
    await call("get_top_of_book", { contractId: C });
    hub.quote(C, { bestBid: 100, bestAsk: 100.25, lastPrice: 100 });
    let res = await call("get_top_of_book", { contractId: C });
    expect(res.data).toMatchObject({ bid: { price: 100, size: null, source: "quote" }, spreadTicks: 1, mid: 100.125, bookValid: false });
    hub.depth(C, [{ type: DOM_TYPE.BestBid, price: 100, volume: 4, timestamp: iso(S) }, { type: DOM_TYPE.BestAsk, price: 100.25, volume: 6, timestamp: iso(S) }]);
    res = await call("get_top_of_book", { contractId: C, history: 10 });
    expect(res.data).toMatchObject({ bid: { price: 100, size: 4, source: "depth" }, ask: { price: 100.25, size: 6, source: "depth" }, bookValid: true });
    expect(res.data.history.map((e: any) => e.source)).toEqual(["quote", "depth"]);
    expect((await call("get_top_of_book", { contractId: C, history: 10_001 })).isError).toBe(true);
  });

  it("answers while the hub has not confirmed yet, saying the feed is not live (the wait fits the 10 s budget)", async () => {
    expect(VALIDATE_MS + SUBSCRIBE_WAIT_MS + TICK_LOOKUP_MS).toBeLessThan(10_000);
    const { call, hub } = await flowSetup({ subscribeWaitMs: 20 });
    hub.gate = new Promise(() => {});
    const res = await call("get_order_flow", { contractId: C });
    expect(res.isError).toBe(false);
    expect(res.data.rows.map((r: any) => r.complete)).toEqual([false]);
    expect(res.data.coverage).toMatchObject({ gaps: [], live: { tradesLive: false, liveSince: null } });
  });

  it("refuses a contract over the cap, and errors without a feed", async () => {
    const { call } = await flowSetup({ maxContracts: 1 });
    expect((await call("get_trades", { contractId: C })).isError).toBe(false);
    const over = await call("get_trades", { contractId: "CON.F.US.MES.Z26" });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/capped at 1 contracts; already subscribed: CON\.F\.US\.MNQ\.Z26/);
    const none = await flowSetup({ noFlow: true });
    const r = await none.call("get_order_flow", { contractId: C });
    expect(r).toMatchObject({ isError: true, text: "Order flow is not available on this server." });
  });
});
