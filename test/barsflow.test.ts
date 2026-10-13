import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlowFeed } from "../src/flowfeed.js";
import { FlowWriter } from "../src/flowstore.js";
import { BARS_FLOW_BUDGET_MS, BARS_FLOW_WAIT_MS, FLOW_SOURCE_ROOT, barsWithFlow, flowSourceContract } from "../src/flowtools.js";
import { loadConfig } from "../src/config.js";
import { EMPTY_BAR_FLOW, MINUTE_MS, addPrint, barFlow, flowWindow, newBucket, recordOf, type MinuteRecord } from "../src/orderflow.js";
import { OK, fakeClock, fakeFlowHub, setup } from "./helpers.js";

const S = Date.UTC(2026, 9, 12, 22, 0); // 17:00 CT session start
const MNQ = "CON.F.US.MNQ.Z26";
const NQ = "CON.F.US.ENQ.Z26";
const iso = (t: number) => new Date(t).toISOString();
const trade = (t: number, price: number, volume: number, type: number) => ({ price, volume, type, timestamp: iso(t) });

async function barsSetup(o: { dir?: string; noFlow?: boolean; maxContracts?: number; bars?: number[]; rawTimes?: string[]; env?: Record<string, string> } = {}) {
  const hub = fakeFlowHub();
  const clock = fakeClock(S + 2 * MINUTE_MS + 10_000);
  const flow = new FlowFeed({ hub, now: clock.now, warn: () => {}, maxContracts: o.maxContracts, timers: { every: () => 1, cancel: () => {} } });
  const barTimes = o.bars ?? [S + 6 * MINUTE_MS, S + 2 * MINUTE_MS, S + 4 * MINUTE_MS];
  const s = await setup({
    clock,
    env: { ...(o.dir ? { PROJECTX_FLOW_DIR: o.dir } : {}), ...o.env },
    deps: o.noFlow ? {} : { flow },
    routes: { "/api/History/retrieveBars": () => ({ ...OK, bars: (o.rawTimes ?? barTimes.map(iso)).map((t) => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 })) }) },
  });
  // The quote feed's session volume follows the prints, so quiet minutes are genuinely quiet.
  const vol = new Map<string, number>();
  const pushTrade = hub.trade;
  hub.trade = (id: string, data: unknown) => {
    for (const it of Array.isArray(data) ? data : [data]) vol.set(id, (vol.get(id) ?? 1000) + (it as any).volume);
    pushTrade(id, data);
  };
  const pump = async (until: number, step = 2_000) => {
    while (clock.t < until) {
      clock.t = Math.min(until, clock.t + step);
      for (const id of flow.contracts()) hub.quote(id, { lastPrice: 100, volume: vol.get(id) ?? 1000 });
      await flow.tick();
    }
  };
  return { ...s, hub, flow, clock, pump };
}

/** A complete or incomplete minute record with the given prints. */
function rec(t: number, prints: Array<[number, number, "buy" | "sell"]>, extra: Partial<MinuteRecord> = {}, complete = true): MinuteRecord {
  const b = newBucket(t);
  for (const [price, size, side] of prints) addPrint(b, { t, price, size, side });
  return { ...recordOf(b, complete), ...extra };
}

const byMinute = (records: MinuteRecord[]) => new Map(records.map((r) => [r.t, r]));

describe("barFlow and flowWindow (pure)", () => {
  it("sums complete minutes: volume-weighted vwap, large prints, summed quote OFI, mean book imbalance", () => {
    const m = byMinute([
      rec(S, [[100, 12, "buy"], [99.75, 3, "sell"]], { ofiQuote: 4, bookImbalance: 0.5 }),
      rec(S + MINUTE_MS, [[100.5, 2, "buy"]], { ofiQuote: -1, bookImbalance: null }),
      rec(S + 2 * MINUTE_MS, [], { ofiQuote: 2, bookImbalance: -0.25 }),
    ]);
    expect(barFlow(m, S, 3, 10)).toEqual({
      bv: 14,
      sv: 3,
      delta: 11,
      trades: 3,
      volume: 17,
      vwap: Number(((1200 + 299.25 + 201) / 17).toFixed(10)),
      ofiTrade: 11 / 17,
      ofiQuote: 5,
      imbalance: 0.125,
      largeBuy: 12,
      largeSell: 0,
      complete: true,
    });
    // A minute with unknown quote OFI makes the bar's unknown; no imbalance anywhere is null.
    const n = byMinute([rec(S, [[100, 1, "buy"]], { ofiQuote: null }), rec(S + MINUTE_MS, [], { ofiQuote: 1 })]);
    expect(barFlow(n, S, 2, 10)).toMatchObject({ ofiQuote: null, imbalance: null, largeBuy: 0, ofiTrade: 1 });
    // No volume: vwap and ofiTrade null, sums zero.
    expect(barFlow(byMinute([rec(S, [], { ofiQuote: 0 })]), S, 1, 10)).toMatchObject({ bv: 0, volume: 0, vwap: null, ofiTrade: null, ofiQuote: 0, complete: true });
  });

  it("a missing or incomplete minute empties the whole bar", () => {
    const m = byMinute([rec(S, [[100, 1, "buy"]]), rec(S + MINUTE_MS, [[100, 1, "buy"]], {}, false)]);
    expect(barFlow(m, S, 2, 10)).toEqual(EMPTY_BAR_FLOW);
    expect(barFlow(m, S, 3, 10)).toEqual(EMPTY_BAR_FLOW);
    expect(barFlow(m, S, 1, 10).complete).toBe(true);
    expect(barFlow(new Map(), S, 1, 10)).toEqual(EMPTY_BAR_FLOW);
  });

  it("windows add bv and sv over the last n spans; any incomplete span makes them null", () => {
    const m = byMinute([rec(S, [[100, 3, "buy"]]), rec(S + MINUTE_MS, [[100, 1, "sell"]]), rec(S + 2 * MINUTE_MS, [])]);
    const span = (t: number) => barFlow(m, t, 1, 10);
    expect(flowWindow(span, S + MINUTE_MS, MINUTE_MS, 2)).toEqual({ ofiTrade: 0.5, delta: 2 });
    expect(flowWindow(span, S + 2 * MINUTE_MS, MINUTE_MS, 1)).toEqual({ ofiTrade: null, delta: 0 });
    expect(flowWindow(span, S + 2 * MINUTE_MS, MINUTE_MS, 3)).toEqual({ ofiTrade: 0.5, delta: 2 });
    expect(flowWindow(span, S + MINUTE_MS, MINUTE_MS, 3)).toEqual({ ofiTrade: null, delta: null });
  });

  it("micro bars take the full-size contract's flow (MNQ → ENQ, MES → EP, same expiry); other contracts their own", () => {
    expect(FLOW_SOURCE_ROOT).toEqual({ MNQ: "ENQ", MES: "EP" });
    expect(flowSourceContract(MNQ)).toBe(NQ);
    expect(flowSourceContract("CON.F.US.MES.Z26")).toBe("CON.F.US.EP.Z26");
    expect(flowSourceContract("con.f.us.mnq.h27")).toBe("con.f.us.ENQ.h27");
    expect(flowSourceContract("CON.F.US.M2K.Z26")).toBe("CON.F.US.M2K.Z26");
    expect(flowSourceContract("CON.F.US.EP.Z26")).toBe("CON.F.US.EP.Z26");
    expect(flowSourceContract("MNQ")).toBe("MNQ");
  });
});

describe("get_bars includeOrderFlow", () => {
  it("is off by default: bars unchanged, nothing subscribed", async () => {
    const { call, hub } = await barsSetup();
    const res = await call("get_bars", { contractId: MNQ, unit: "minute", unitNumber: 2, limit: 3 });
    expect(res.data.bars[0]).toEqual({ t: iso(S + 2 * MINUTE_MS), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    expect(res.data.orderFlow).toBeUndefined();
    expect(hub.calls).toEqual([]);
  });

  it("adds NQ's per-minute flow to each MNQ bar, empty unless every minute is complete, with windows", async () => {
    const { call, hub, pump } = await barsSetup();
    const args = { contractId: MNQ, unit: "minute", unitNumber: 2, limit: 3, includeOrderFlow: true, flowWindows: [2, 2, 1] };
    const first = await call("get_bars", args);
    expect(first.isError).toBe(false);
    expect(hub.subscribes()).toEqual([`trades:${NQ}`, `depth:${NQ}`, `quotes:${NQ}`]);
    await pump(S + 4 * MINUTE_MS + 2_000);
    hub.trade(NQ, [trade(S + 4 * MINUTE_MS + 1_000, 100, 12, 0), trade(S + 4 * MINUTE_MS + 2_000, 99.75, 3, 1)]);
    // MNQ's own prints never reach MNQ bars' flow (it is not even subscribed).
    hub.trade(MNQ, [trade(S + 4 * MINUTE_MS + 3_000, 100, 50, 0)]);
    await pump(S + 5 * MINUTE_MS + 2_000);
    hub.trade(NQ, [trade(S + 5 * MINUTE_MS + 1_000, 100, 2, 0)]);
    await pump(S + 8 * MINUTE_MS + 12_000);
    const res = await call("get_bars", args);
    expect(res.data.orderFlow).toMatchObject({ sourceContractId: NQ, largePrint: 10, windows: [1, 2], recorded: "off (PROJECTX_FLOW_DIR not set)" });
    expect(res.data.orderFlow.note).toMatch(/complete=true means/);
    const [b2, b4, b6] = res.data.bars;
    expect([b2.t, b4.t, b6.t]).toEqual([iso(S + 2 * MINUTE_MS), iso(S + 4 * MINUTE_MS), iso(S + 6 * MINUTE_MS)]);
    expect(b2).toMatchObject({ o: 1, v: 10 });
    // The bar holding the first, partial minute after the subscribe has no flow.
    expect(b2.flow).toEqual({ ...EMPTY_BAR_FLOW, windows: { "1": { ofiTrade: null, delta: null }, "2": { ofiTrade: null, delta: null } } });
    expect(b4.flow).toEqual({
      bv: 14,
      sv: 3,
      delta: 11,
      trades: 3,
      volume: 17,
      vwap: Number(((1200 + 299.25 + 200) / 17).toFixed(10)),
      ofiTrade: 11 / 17,
      ofiQuote: null,
      imbalance: null,
      largeBuy: 12,
      largeSell: 0,
      complete: true,
      windows: { "1": { ofiTrade: 11 / 17, delta: 11 }, "2": { ofiTrade: null, delta: null } },
    });
    expect(b6.flow).toMatchObject({ bv: 0, sv: 0, delta: 0, volume: 0, vwap: null, ofiTrade: null, complete: true, windows: { "1": { ofiTrade: null, delta: 0 }, "2": { ofiTrade: 11 / 17, delta: 11 } } });
    expect(hub.subscribes().filter((s) => s.includes("MNQ"))).toEqual([]);
  });

  it("prefers the recorder's complete minutes for the bar's span, as get_order_flow does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pxbf-"));
    const w = new FlowWriter(dir, 10, () => {});
    // The two minutes before the first bar are read too: the 2-bar window of the first bar needs them.
    for (const [t, bv, sv] of [[S, 3, 0], [S + MINUTE_MS, 0, 1], [S + 2 * MINUTE_MS, 5, 1], [S + 3 * MINUTE_MS, 2, 2]]) w.write(NQ, rec(t, [[100, bv, "buy"], [99.75, sv, "sell"]].filter(([, n]) => n) as any));
    const { call, hub, pump } = await barsSetup({ dir });
    const args = { contractId: MNQ, unit: "minute", unitNumber: 2, includeOrderFlow: true, flowWindows: [2] };
    await call("get_bars", args);
    await pump(S + 4 * MINUTE_MS + 2_000);
    hub.trade(NQ, trade(S + 4 * MINUTE_MS + 1_000, 100, 4, 1));
    await pump(S + 6 * MINUTE_MS + 12_000);
    const res = await call("get_bars", args);
    const [b2, b4] = res.data.bars;
    // S+3m is a complete live minute (zero), which is kept over the recorded one.
    expect(b2.flow).toMatchObject({ bv: 5, sv: 1, delta: 4, complete: true, windows: { "2": { ofiTrade: 0.6, delta: 6 } } });
    expect(b4.flow).toMatchObject({ bv: 0, sv: 4, delta: -4, complete: true, windows: { "2": { ofiTrade: 0, delta: 0 } } });
    expect(res.data.orderFlow.recorded).toMatchObject({ rows: 4, truncated: false, error: null });
  });

  it("hour bars use 60-minute spans", async () => {
    const H = Date.UTC(2026, 9, 12, 12, 0);
    const dir = mkdtempSync(join(tmpdir(), "pxbf-"));
    const w = new FlowWriter(dir, 10, () => {});
    for (let k = 0; k < 60; k++) w.write(NQ, rec(H + k * MINUTE_MS, [[100, 1, "buy"]]));
    const { call } = await barsSetup({ dir, bars: [H, H + 3600_000] });
    const res = await call("get_bars", { contractId: NQ, unit: "hour", unitNumber: 1, includeOrderFlow: true });
    expect(res.data.orderFlow).toMatchObject({ sourceContractId: NQ, windows: [] });
    expect(res.data.bars[0].flow).toMatchObject({ bv: 60, sv: 0, trades: 60, complete: true, windows: {} });
    expect(res.data.bars[1].flow).toEqual({ ...EMPTY_BAR_FLOW, windows: {} });
  });

  it("other units, a server without a feed, and a refused subscription give empty flow with a note", async () => {
    const a = await barsSetup();
    const sec = await a.call("get_bars", { contractId: MNQ, unit: "second", unitNumber: 30, includeOrderFlow: true, flowWindows: [3] });
    expect(sec.data.orderFlow.note).toMatch(/only minute and hour bars/);
    expect(sec.data.bars.every((b: any) => b.flow.complete === false && b.flow.bv === null && b.flow.windows["3"].delta === null)).toBe(true);
    expect((await a.call("get_bars", { contractId: MNQ, unit: "day", includeOrderFlow: true })).data.orderFlow.note).toMatch(/only minute and hour/);
    expect(a.hub.calls).toEqual([]);

    const b = await barsSetup({ noFlow: true });
    const none = await b.call("get_bars", { contractId: MNQ, includeOrderFlow: true });
    expect(none.isError).toBe(false);
    expect(none.data.orderFlow.note).toBe("Order flow is not available on this server.");

    const c = await barsSetup({ maxContracts: 1 });
    await c.call("get_trades", { contractId: "CON.F.US.MES.Z26" });
    const capped = await c.call("get_bars", { contractId: MNQ, includeOrderFlow: true });
    expect(capped.isError).toBe(false);
    expect(capped.data.orderFlow.note).toMatch(/Order flow unavailable for CON\.F\.US\.ENQ\.Z26: .*capped at 1/);
    expect(capped.data.bars).toHaveLength(3);

    const d = await barsSetup({ bars: [] });
    expect((await d.call("get_bars", { contractId: MNQ, includeOrderFlow: true })).data).toMatchObject({ count: 0, bars: [], orderFlow: { note: "No bar has a usable time." } });
  });

  it("a bar whose time does not parse gets empty flow; the others still get theirs", async () => {
    const { call } = await barsSetup({ rawTimes: [iso(S + 2 * MINUTE_MS), "not a time"] });
    const res = await call("get_bars", { contractId: MNQ, includeOrderFlow: true, flowWindows: [1] });
    const bad = res.data.bars.find((b: any) => b.t === "not a time");
    expect(bad.flow).toEqual({ ...EMPTY_BAR_FLOW, windows: { "1": { ofiTrade: null, delta: null } } });
    expect(res.data.bars).toHaveLength(2);
    expect(res.data.orderFlow.recorded).toBe("off (PROJECTX_FLOW_DIR not set)");
  });

  it("rejects bad windows", async () => {
    const { call } = await barsSetup();
    expect((await call("get_bars", { contractId: MNQ, includeOrderFlow: true, flowWindows: [0] })).isError).toBe(true);
    expect((await call("get_bars", { contractId: MNQ, includeOrderFlow: true, flowWindows: [51] })).isError).toBe(true);
    expect((await call("get_bars", { contractId: MNQ, includeOrderFlow: true, flowWindows: [1, 2, 3, 4, 5, 6] })).isError).toBe(true);
  });

  describe("server defaults (PROJECTX_BARS_ORDER_FLOW, PROJECTX_BARS_FLOW_WINDOWS)", () => {
    const ON = { PROJECTX_BARS_ORDER_FLOW: "true" };

    it("default off: no env, no args gives plain bars and subscribes nothing", async () => {
      const { call, hub, config } = await barsSetup();
      expect(config).toMatchObject({ barsOrderFlow: false, barsFlowWindows: [] });
      const res = await call("get_bars", { contractId: MNQ });
      expect(res.data.orderFlow).toBeUndefined();
      expect(res.data.bars[0].flow).toBeUndefined();
      expect(hub.calls).toEqual([]);
    });

    it("env on with no args gives flow", async () => {
      const { call, hub } = await barsSetup({ env: ON });
      const res = await call("get_bars", { contractId: MNQ });
      expect(res.isError).toBe(false);
      expect(res.data.orderFlow).toMatchObject({ sourceContractId: NQ, windows: [] });
      expect(res.data.bars.every((b: any) => b.flow && b.flow.windows)).toBe(true);
      expect(hub.subscribes()).toEqual([`trades:${NQ}`, `depth:${NQ}`, `quotes:${NQ}`]);
    });

    it("an explicit includeOrderFlow: false wins over env on", async () => {
      const { call, hub } = await barsSetup({ env: { ...ON, PROJECTX_BARS_FLOW_WINDOWS: "3" } });
      const res = await call("get_bars", { contractId: MNQ, includeOrderFlow: false });
      expect(res.data.orderFlow).toBeUndefined();
      expect(res.data.bars[0].flow).toBeUndefined();
      expect(hub.calls).toEqual([]);
    });

    it("env windows apply when the call passes none, with env flow or an explicit includeOrderFlow", async () => {
      const a = await barsSetup({ env: { ...ON, PROJECTX_BARS_FLOW_WINDOWS: "5, 2" } });
      const res = await a.call("get_bars", { contractId: MNQ });
      expect(res.data.orderFlow.windows).toEqual([2, 5]);
      expect(Object.keys(res.data.bars[0].flow.windows)).toEqual(["2", "5"]);
      const b = await barsSetup({ env: { PROJECTX_BARS_FLOW_WINDOWS: "4" } });
      expect((await b.call("get_bars", { contractId: MNQ })).data.orderFlow).toBeUndefined();
      expect((await b.call("get_bars", { contractId: MNQ, includeOrderFlow: true })).data.orderFlow.windows).toEqual([4]);
    });

    it("explicit flowWindows win over env windows, including an explicit []", async () => {
      const { call } = await barsSetup({ env: { ...ON, PROJECTX_BARS_FLOW_WINDOWS: "5,10" } });
      expect((await call("get_bars", { contractId: MNQ, flowWindows: [3] })).data.orderFlow.windows).toEqual([3]);
      expect((await call("get_bars", { contractId: MNQ, flowWindows: [] })).data.orderFlow.windows).toEqual([]);
    });

    it("get_server_config shows the defaults", async () => {
      const { call } = await barsSetup({ env: { ...ON, PROJECTX_BARS_FLOW_WINDOWS: "5" } });
      expect((await call("get_server_config")).data.flow).toMatchObject({ barsOrderFlow: true, barsFlowWindows: [5] });
      const off = await barsSetup();
      expect((await off.call("get_server_config")).data.flow).toMatchObject({ barsOrderFlow: false, barsFlowWindows: [] });
    });

    const base = { PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" };
    const W = (v: string) => () => loadConfig({ ...base, PROJECTX_BARS_FLOW_WINDOWS: v });
    const F = (v: string) => () => loadConfig({ ...base, PROJECTX_BARS_ORDER_FLOW: v });

    it("PROJECTX_BARS_ORDER_FLOW: trimmed, lowercased, empty is false, only true or false", () => {
      expect(loadConfig({ ...base, PROJECTX_BARS_ORDER_FLOW: " TRUE " }).barsOrderFlow).toBe(true);
      expect(loadConfig({ ...base, PROJECTX_BARS_ORDER_FLOW: "False" }).barsOrderFlow).toBe(false);
      expect(loadConfig({ ...base, PROJECTX_BARS_ORDER_FLOW: "  " }).barsOrderFlow).toBe(false);
      expect(F("yes")).toThrow('PROJECTX_BARS_ORDER_FLOW must be "true" or "false", got "yes"');
      expect(F(" 1 ")).toThrow('PROJECTX_BARS_ORDER_FLOW must be "true" or "false", got "1"');
    });

    it("PROJECTX_BARS_FLOW_WINDOWS: trimmed items; blank is none", () => {
      expect(loadConfig({ ...base, PROJECTX_BARS_FLOW_WINDOWS: " 1, 50 ,20" }).barsFlowWindows).toEqual([1, 50, 20]);
      expect(loadConfig({ ...base, PROJECTX_BARS_FLOW_WINDOWS: "  " }).barsFlowWindows).toEqual([]);
      expect(loadConfig({ ...base, PROJECTX_BARS_FLOW_WINDOWS: "1,2,3,4,5" }).barsFlowWindows).toEqual([1, 2, 3, 4, 5]);
    });

    it("PROJECTX_BARS_FLOW_WINDOWS: digits only, an empty item is invalid", () => {
      const msg = (item: string) => `PROJECTX_BARS_FLOW_WINDOWS windows must be whole numbers from 1 to 50, got "${item}"`;
      for (const item of ["0x10", "1e1", "+5", "5.0", "five", "-1"]) expect(W(item)).toThrow(msg(item));
      expect(W("5,,20")).toThrow(msg(""));
      expect(W("5,20,")).toThrow(msg(""));
      // Digits are checked for every item before any range: "x" is reported, not "0".
      expect(W("0,x")).toThrow(msg("x"));
    });

    it("PROJECTX_BARS_FLOW_WINDOWS: each window 1 to 50", () => {
      const msg = (item: string) => `PROJECTX_BARS_FLOW_WINDOWS windows must be whole numbers from 1 to 50, got "${item}"`;
      expect(W("0")).toThrow(msg("0"));
      expect(W("51")).toThrow(msg("51"));
      // Range is checked before duplicates.
      expect(W("5,5,51")).toThrow(msg("51"));
    });

    it("PROJECTX_BARS_FLOW_WINDOWS: no duplicates, checked before the count", () => {
      expect(W("5,5")).toThrow("PROJECTX_BARS_FLOW_WINDOWS has a duplicate window 5");
      expect(W("05,5")).toThrow("PROJECTX_BARS_FLOW_WINDOWS has a duplicate window 5");
      expect(W("1,2,3,4,5,6,1")).toThrow("PROJECTX_BARS_FLOW_WINDOWS has a duplicate window 1");
    });

    it("PROJECTX_BARS_FLOW_WINDOWS: at most 5 windows", () => {
      expect(W("1,2,3,4,5,6")).toThrow(/^PROJECTX_BARS_FLOW_WINDOWS allows at most 5 windows$/);
    });

    it("get_bars' input descriptions are static: they never show env values", async () => {
      const schema = async (env: Record<string, string>) => {
        const { client } = await barsSetup({ env });
        const tool = (await client.listTools()).tools.find((t) => t.name === "get_bars")!;
        return tool;
      };
      const off = await schema({});
      const on = await schema({ PROJECTX_BARS_ORDER_FLOW: "true", PROJECTX_BARS_FLOW_WINDOWS: "5,20" });
      expect(on).toEqual(off);
      const props = off.inputSchema.properties as Record<string, { description?: string; default?: unknown }>;
      expect(props.includeOrderFlow.description).toContain("Default: the server's PROJECTX_BARS_ORDER_FLOW (false unless set)");
      expect(props.flowWindows.description).toContain("Default: the server's PROJECTX_BARS_FLOW_WINDOWS (none unless set)");
      expect(props.includeOrderFlow.default).toBeUndefined();
      expect(props.flowWindows.default).toBeUndefined();
    });
  });

  it("answers within its wait when the hub never confirms the subscription", async () => {
    const { call, hub } = await barsSetup();
    hub.gate = new Promise(() => {});
    const t0 = Date.now();
    const res = await call("get_bars", { contractId: MNQ, unit: "minute", unitNumber: 2, includeOrderFlow: true });
    expect(Date.now() - t0).toBeLessThan(BARS_FLOW_WAIT_MS + 1_500);
    expect(res.isError).toBe(false);
    expect(res.data.bars.every((b: any) => b.flow.complete === false)).toBe(true);
  });
});

describe("get_bars order flow: bounds", () => {
  it("MES bars subscribe and carry ES's flow (EP)", async () => {
    const { call, hub } = await barsSetup();
    const res = await call("get_bars", { contractId: "CON.F.US.MES.Z26", includeOrderFlow: true });
    expect(res.data.orderFlow.sourceContractId).toBe("CON.F.US.EP.Z26");
    expect(hub.subscribes()).toEqual(["trades:CON.F.US.EP.Z26", "depth:CON.F.US.EP.Z26", "quotes:CON.F.US.EP.Z26"]);
  });

  it("the flow part answers within its budget, then the bars come with empty flow and a note", async () => {
    expect(BARS_FLOW_BUDGET_MS).toBeLessThanOrEqual(3_000);
    const hub = fakeFlowHub();
    // A contract check that never answers: ensure() would wait forever.
    const flow = new FlowFeed({ hub, warn: () => {}, validate: () => new Promise(() => {}), timers: { every: () => 1, cancel: () => {} } });
    const config = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" });
    const bars = [{ t: iso(S) }];
    const t0 = Date.now();
    const res = await barsWithFlow({ config, flow, now: Date.now, warn: () => {} }, MNQ, bars, "minute", 1, [2], 50);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(res.orderFlow.note).toBe(`Order flow for ${NQ} took longer than 50 ms; the bars come without it.`);
    expect(res.bars).toEqual([{ t: iso(S), flow: { ...EMPTY_BAR_FLOW, windows: { "2": { ofiTrade: null, delta: null } } } }]);
  });

  it("an error while reading the minutes gives empty flow and a note, not a failed call", async () => {
    const hub = fakeFlowHub();
    const flow = new FlowFeed({ hub, warn: () => {}, timers: { every: () => 1, cancel: () => {} } });
    flow.records = () => {
      throw new Error("boom");
    };
    const config = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" });
    const res = await barsWithFlow({ config, flow, now: Date.now, warn: () => {} }, NQ, [{ t: iso(S) }], "minute", 1, []);
    expect(res.orderFlow.note).toBe(`Order flow for ${NQ} failed: boom`);
    expect(res.bars[0].flow.complete).toBe(false);
  });

  /** A feed whose first trades subscribe is refused only after the caller stopped waiting (10 ms). */
  function slowRefusal(maxContracts = 1) {
    const hub = fakeFlowHub();
    let open!: () => void;
    hub.gate = new Promise<void>((r) => (open = r));
    hub.fail = (kind) => (kind === "trades" ? new Error("unknown contract") : null);
    const warnings: string[] = [];
    const flow = new FlowFeed({ hub, warn: (l) => void warnings.push(l), maxContracts, subscribeWaitMs: 10, timers: { every: () => 1, cancel: () => {} } });
    const release = async () => {
      hub.gate = null;
      open();
      for (let k = 0; k < 3; k++) await new Promise((r) => setTimeout(r, 0));
    };
    return { hub, flow, release, warnings, unsubscribes: () => hub.calls.filter(([op]) => op === "unsubscribe").length };
  }

  it("get_bars' subscribe: a first subscribe refused after the caller stopped waiting frees its slot", async () => {
    const { hub, flow, release, unsubscribes } = slowRefusal();
    await flow.ensure(NQ, 10, { dropLateRefusal: true });
    expect(flow.contracts()).toEqual([NQ]);
    await release();
    expect(flow.contracts()).toEqual([]);
    expect(unsubscribes()).toBe(3);
    // The slot is free again for another contract.
    await expect(flow.ensure("CON.F.US.EP.Z26")).rejects.toThrow(/Could not subscribe to CON\.F\.US\.EP\.Z26: unknown contract/);
    hub.fail = () => null;
    await flow.ensure("CON.F.US.EP.Z26");
    expect(flow.contracts()).toEqual(["CON.F.US.EP.Z26"]);
  });

  it("the other flow tools' subscribe is unchanged: after a slow refusal the contract keeps its state and slot, as before", async () => {
    const { flow, release, unsubscribes } = slowRefusal();
    await flow.ensure(NQ); // what get_order_flow, get_footprint, get_trades, get_market_depth and get_top_of_book call
    await release();
    expect(flow.contracts()).toEqual([NQ]);
    expect(unsubscribes()).toBe(0);
    await expect(flow.ensure("CON.F.US.EP.Z26")).rejects.toThrow(/capped at 1/);
  });

  it("get_bars' late drop and a waiting caller drop a refused contract once, and the caller still fails", async () => {
    const { flow, release, unsubscribes, warnings } = slowRefusal(2);
    await flow.ensure(NQ, 10, { dropLateRefusal: true });
    const waiting = flow.ensure(NQ, 1_000, { dropLateRefusal: true });
    await release();
    await expect(waiting).rejects.toThrow(/Could not subscribe to CON\.F\.US\.ENQ\.Z26/);
    expect(unsubscribes()).toBe(3);
    expect(warnings.filter((w) => w.includes("subscribing trades"))).toHaveLength(1);
    expect(flow.contracts()).toEqual([]);
  });

  it("the late drop never removes a newer state for the same contract", async () => {
    const { hub, flow, release } = slowRefusal(2);
    let tradeSubscribes = 0;
    hub.fail = (kind) => (kind === "trades" && ++tradeSubscribes === 1 ? new Error("unknown contract") : null);
    await flow.ensure(NQ, 10, { dropLateRefusal: true });
    await flow.drop(NQ, false);
    // A new state for the same contract, whose subscribe will succeed.
    await flow.ensure(NQ, 10);
    await release();
    expect(tradeSubscribes).toBe(2);
    expect(flow.contracts()).toEqual([NQ]);
  });

  it("get_bars passes the late drop: its refused subscribe frees the slot for the other tools", async () => {
    const { call, hub } = await barsSetup({ maxContracts: 1 });
    let open!: () => void;
    hub.gate = new Promise<void>((r) => (open = r));
    hub.fail = (kind, id) => (kind === "trades" && id === NQ ? new Error("unknown contract") : null);
    const res = await call("get_bars", { contractId: MNQ, includeOrderFlow: true });
    expect(res.data.bars.every((b: any) => b.flow.complete === false)).toBe(true);
    hub.gate = null;
    open();
    for (let k = 0; k < 3; k++) await new Promise((r) => setTimeout(r, 0));
    expect((await call("get_trades", { contractId: "CON.F.US.EP.Z26" })).isError).toBe(false);
  });
});
