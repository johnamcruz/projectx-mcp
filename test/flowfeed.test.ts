import { describe, expect, it } from "vitest";
import { FLOW_LIMITS, FLOW_TICK_MS, FlowCapError, FlowFeed, RESOLVE_RETRY_MS, resolveActiveContract, type FlowFeedOptions } from "../src/flowfeed.js";
import { DOM_TYPE, MAX_LAG_WINDOW_MS, MINUTE_MS, lagWindowMs, type MinuteRecord } from "../src/orderflow.js";
import { OK, fakeApi, fakeClock, fakeFlowHub } from "./helpers.js";

const M0 = Date.UTC(2026, 9, 12, 14, 30); // a minute start (09:30 CT)
const T0 = M0 + 10_000; // subscribed 10 s into the minute
const C = "CON.F.US.MNQ.Z26";
const iso = (t: number) => new Date(t).toISOString();
const trade = (t: number, price: number, volume: number, type: number) => ({ symbolId: "F.US.MNQ", price, timestamp: iso(t), type, volume });

function manualTimers() {
  const fns = new Map<number, () => void>();
  let next = 1;
  return {
    fns,
    every: (_ms: number, fn: () => void) => (fns.set(next, fn), next++),
    cancel: (h: unknown) => void fns.delete(h as number),
  };
}

function make(o: Partial<FlowFeedOptions> = {}) {
  const hub = fakeFlowHub();
  const clock = fakeClock(T0);
  const warnings: string[] = [];
  const minutes: Array<[string, MinuteRecord]> = [];
  const timers = manualTimers();
  const feed = new FlowFeed({
    hub,
    now: clock.now,
    ticks: { get: async () => 0.25 },
    warn: (l) => void warnings.push(l),
    timers,
    onMinute: (id, r) => void minutes.push([id, r]),
    ...o,
  });
  // The quote feed's session volume follows the prints the test pushes, so quiet minutes are genuinely quiet.
  // With setLag(ms) the quote's volume (and lastPrice) catch up with a print only `ms` after it arrived.
  const lag = { ms: 0, followPrice: false };
  const updates = new Map<string, Array<{ at: number; add: number; price: number }>>();
  const pushTrade = hub.trade;
  hub.trade = (id: string, data: unknown) => {
    const items = Array.isArray(data) ? data : [data];
    const list = updates.get(id) ?? [];
    for (const it of items) {
      if (it && typeof (it as any).volume === "number" && [0, 1].includes((it as any).type)) list.push({ at: clock.t + lag.ms, add: (it as any).volume, price: (it as any).price });
    }
    updates.set(id, list);
    pushTrade(id, data);
  };
  const quoteOf = (id: string) => {
    const due = (updates.get(id) ?? []).filter((u) => u.at <= clock.t);
    const price = lag.followPrice && due.length ? due[due.length - 1].price : 100;
    return { lastPrice: price, volume: 1000 + due.reduce((n, u) => n + u.add, 0) };
  };
  const setLag = (ms: number, followPrice = true) => Object.assign(lag, { ms, followPrice });
  /** Keep the feed alive like a busy market: a quote (with the matching session volume) every `step` ms and a maintenance pass, until `until`. */
  const pump = async (until: number, ids: string[] = [C], step = 2_000) => {
    while (clock.t < until) {
      clock.t = Math.min(until, clock.t + step);
      for (const id of ids) hub.quote(id, quoteOf(id));
      await feed.tick();
    }
  };
  return { hub, clock, feed, warnings, minutes, timers, pump, setLag };
}

describe("FlowFeed subscriptions", () => {
  it("subscribes trades, depth and quotes lazily on first use, once", async () => {
    const { hub, feed, timers } = make();
    expect(hub.calls).toEqual([]);
    expect(timers.fns.size).toBe(0);
    await feed.ensure(C);
    expect(hub.subscribes()).toEqual([`trades:${C}`, `depth:${C}`, `quotes:${C}`]);
    await feed.ensure(C);
    expect(hub.subscribes()).toHaveLength(3);
    expect(timers.fns.size).toBe(1);
    expect(feed.coverage(C)).toMatchObject({ subscribedAt: iso(T0), liveSince: iso(T0), tradesLive: true, depthLive: true, quotesLive: true });
  });

  it("refuses contracts beyond the cap with a clear error", async () => {
    const { feed } = make({ maxContracts: 2 });
    await feed.ensure("A");
    await feed.ensure("B");
    await expect(feed.ensure("C")).rejects.toThrow(FlowCapError);
    await expect(feed.ensure("C")).rejects.toThrow(/capped at 2 contracts; already subscribed: A, B/);
    await feed.ensure("A"); // an existing contract is fine
    expect(feed.contracts()).toEqual(["A", "B"]);
    expect(FLOW_LIMITS.maxContracts).toBe(6);
  });

  it("answers after the wait even when the hub never confirms, and is live once it does", async () => {
    const { hub, feed } = make();
    let open!: () => void;
    hub.gate = new Promise<void>((r) => (open = r));
    await feed.ensure(C, 5);
    expect(feed.coverage(C)).toMatchObject({ tradesLive: false, liveSince: null });
    open();
    await new Promise((r) => setTimeout(r, 0));
    await feed.ensure(C, 5);
    expect(feed.coverage(C).tradesLive).toBe(true);
  });

  it("warns once on a failed subscribe and retries it on the maintenance tick", async () => {
    const { hub, feed, warnings } = make();
    hub.fail = (kind) => (kind === "depth" ? new Error("hub refused") : null);
    await feed.ensure(C);
    await feed.tick();
    expect(warnings.filter((w) => /subscribing depth .* failed: hub refused/.test(w))).toHaveLength(1);
    expect(feed.coverage(C)).toMatchObject({ tradesLive: true, depthLive: false, errors: { depth: "hub refused" } });
    hub.fail = () => null;
    await feed.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.coverage(C)).toMatchObject({ depthLive: true, errors: {} });
    expect(hub.subscribes("depth").length).toBeGreaterThanOrEqual(3);
  });

  it("on a disconnect: marks the gap, clears the book, and resubscribes what the hub did not restore", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    hub.depth(C, [{ timestamp: iso(T0), type: DOM_TYPE.Bid, price: 100, volume: 5 }, { timestamp: iso(T0), type: DOM_TYPE.Ask, price: 100.25, volume: 4 }]);
    expect((await feed.depth(C, { levels: 10, imbalanceLevels: 5 })).valid).toBe(true);
    clock.t = M0 + 90_000;
    hub.down();
    const d = await feed.depth(C, { levels: 10, imbalanceLevels: 5, history: 1 });
    expect(d).toMatchObject({ valid: false, bids: [], asks: [], bestBid: null, ageMs: 0 });
    expect(d.history).toEqual([{ t: iso(M0 + 90_000), side: null, price: null, size: 0, prevSize: 0, type: DOM_TYPE.Reset }]);
    // The live interval ends at the last message seen (the depth push at T0), not at detection.
    expect(feed.coverage(C)).toMatchObject({ tradesLive: false, liveSince: null, disconnects: [iso(T0)] });
    await feed.tick();
    expect(hub.subscribes()).toEqual([`trades:${C}`, `depth:${C}`, `quotes:${C}`, `trades:${C}`, `depth:${C}`, `quotes:${C}`]);
    expect(feed.coverage(C).liveSince).toBe(iso(M0 + 90_000));
  });

  it("starts the maintenance timer and stops everything on close", async () => {
    const { hub, feed, timers } = make();
    await feed.start();
    await feed.ensure(C);
    expect(timers.fns.size).toBe(1);
    await feed.close();
    expect(timers.fns.size).toBe(0);
    expect(hub.calls.filter(([op]) => op === "unsubscribe").map(([, k]) => k)).toEqual(["trades", "depth", "quotes"]);
    expect(hub.listeners.size).toBe(0);
    expect(feed.contracts()).toEqual([]);
    expect(() => feed.coverage(C)).toThrow(/No order-flow subscription/);
    await feed.ensure(C); // after close: no timer restarts
    expect(timers.fns.size).toBe(0);
  });
});

describe("FlowFeed minutes", () => {
  it("aggregates prints per UTC minute; the first partial minute is incomplete, a covered zero-trade minute is complete", async () => {
    const { hub, feed, pump } = make();
    await feed.ensure(C);
    await pump(M0 + 30_000);
    hub.trade(C, [trade(M0 + 20_000, 100, 2, 0), trade(M0 + 30_000, 100.25, 1, 1)]);
    await pump(M0 + 80_000);
    hub.trade(C, trade(M0 + 80_000, 100.5, 12, 0));
    hub.trade(C, [trade(M0 + 80_000, 100, 10, 1)]);
    await pump(M0 + 3 * MINUTE_MS + 12_000);
    const r = feed.records(C, M0 - MINUTE_MS, M0 + 3 * MINUTE_MS);
    expect(r.map((x) => [iso(x.t), x.complete, x.bv, x.sv])).toEqual([
      [iso(M0), false, 2, 1],
      [iso(M0 + MINUTE_MS), true, 12, 10],
      [iso(M0 + 2 * MINUTE_MS), true, 0, 0],
      [iso(M0 + 3 * MINUTE_MS), false, 0, 0],
    ]);
  });

  it("a minute overlapping a disconnect is incomplete; minutes after the reconnect are complete", async () => {
    const { hub, feed, clock, pump } = make();
    await feed.ensure(C);
    await pump(M0 + 90_000);
    hub.down();
    clock.t = M0 + 92_000;
    hub.resubscribed("trades", C);
    await pump(M0 + 3 * MINUTE_MS + 12_000);
    const r = feed.records(C, M0, M0 + 2 * MINUTE_MS);
    expect(r.map((x) => x.complete)).toEqual([false, false, true]);
  });

  it("emits each complete minute once after it is final, never an incomplete one", async () => {
    const { hub, feed, clock, minutes, pump } = make();
    await feed.ensure(C);
    await pump(M0 + 70_000);
    hub.trade(C, trade(M0 + 70_000, 100, 3, 0));
    await pump(M0 + 2 * MINUTE_MS + 9_000, [C], 1_000); // minute 1 ended; quotes alone don't settle it before end + 10 s
    expect(minutes).toEqual([]);
    hub.trade(C, trade(clock.t, 100, 1, 0)); // a trade message after end + grace settles it now
    await feed.tick();
    await feed.tick();
    expect(minutes.map(([id, r]) => [id, iso(r.t), r.bv, r.complete])).toEqual([[C, iso(M0 + MINUTE_MS), 3, true]]);
    await pump(M0 + 3 * MINUTE_MS + 30_000);
    hub.down(); // minute 3 will be incomplete
    clock.t = M0 + 5 * MINUTE_MS + 5_000;
    hub.resubscribed("trades", C);
    await feed.tick();
    expect(minutes.map(([, r]) => iso(r.t))).toEqual([iso(M0 + MINUTE_MS), iso(M0 + 2 * MINUTE_MS)]);
  });

  it("drop finalizes the contract's final minutes before forgetting it", async () => {
    const { feed, minutes, hub, pump, clock } = make();
    await feed.ensure(C);
    await pump(M0 + 4 * MINUTE_MS + 9_000);
    minutes.length = 0;
    clock.t = M0 + 4 * MINUTE_MS + 10_000; // minute 3 settles now; no tick ran since
    hub.quote(C, { lastPrice: 100, volume: 1000 });
    await feed.drop(C);
    expect(minutes.map(([, r]) => iso(r.t))).toEqual([iso(M0 + 3 * MINUTE_MS)]);
    expect(feed.contracts()).toEqual([]);
    await feed.drop(C);
    expect(hub.calls.filter(([op]) => op === "unsubscribe")).toHaveLength(3);
  });

  it("a recording failure is warned, never thrown", async () => {
    const { feed, warnings, pump } = make({ onMinute: () => { throw new Error("disk full"); } });
    await feed.ensure(C);
    await pump(M0 + 2 * MINUTE_MS + 15_000);
    expect(warnings.some((w) => /recording .* failed: disk full/.test(w))).toBe(true);
  });

  it("prunes minutes older than the 24 h history", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    hub.trade(C, trade(M0 + 20_000, 100, 1, 0));
    clock.t = M0 + FLOW_LIMITS.historyMs + 5 * MINUTE_MS;
    hub.trade(C, trade(clock.t, 100, 1, 0));
    await feed.tick();
    expect(feed.records(C, M0, M0).length).toBe(1);
    expect(feed.records(C, M0, M0)[0].bv).toBe(0);
  });

  it("skips malformed payloads and counts bad timestamps; events for other contracts are ignored", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    expect(() => {
      hub.trade(C, "junk");
      hub.trade(C, [null, { price: 1 }]);
      hub.depth(C, [null, { type: 2, price: "x" }]);
      hub.depth(C, []);
      hub.trade("OTHER", trade(T0, 1, 1, 0));
      hub.depth("OTHER", []);
      hub.quote("OTHER", { bestBid: 1 });
    }).not.toThrow();
    hub.trade(C, { price: 100, volume: 1, type: 0, timestamp: "not a time" });
    expect(feed.coverage(C)).toMatchObject({ skippedItems: 5, badTimestamps: 1 });
    expect(feed.prints(C, { limit: 10 })).toEqual([{ t: clock.t, price: 100, size: 1, side: "buy", badTimestamp: true }]);
  });
});

describe("FlowFeed L1 and L2", () => {
  const book = (bid: number, bidSize: number, ask: number, askSize: number) => [
    { timestamp: iso(T0), type: DOM_TYPE.BestBid, price: bid, volume: bidSize },
    { timestamp: iso(T0), type: DOM_TYPE.BestAsk, price: ask, volume: askSize },
  ];

  it("top of book falls back to the quote without a book, then uses the depth feed", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    expect(await feed.topOfBook(C)).toMatchObject({ bid: null, ask: null, last: null, spreadTicks: null, mid: null, bookValid: false });
    hub.quote(C, { bestBid: 100, bestAsk: 100.5, lastPrice: 100.25 });
    clock.t += 1_000;
    let top = await feed.topOfBook(C, 10);
    expect(top).toMatchObject({
      bid: { price: 100, size: null, source: "quote", ageMs: 1_000 },
      ask: { price: 100.5, size: null, source: "quote" },
      last: { price: 100.25, size: null, side: null, source: "quote" },
      spreadTicks: 2,
      mid: 100.25,
    });
    expect(top.history).toEqual([{ t: iso(T0), bid: 100, bidSize: null, ask: 100.5, askSize: null, source: "quote" }]);
    hub.depth(C, book(100.25, 7, 100.5, 3));
    hub.trade(C, trade(clock.t - 500, 100.5, 2, 0));
    hub.quote(C, { bestBid: 99 }); // ignored for L1 while the book is valid
    clock.t += 2_000;
    top = await feed.topOfBook(C, 10);
    expect(top).toMatchObject({
      bid: { price: 100.25, size: 7, source: "depth", ageMs: 2_000 },
      ask: { price: 100.5, size: 3, source: "depth" },
      last: { price: 100.5, size: 2, side: "buy", source: "trades", ageMs: 2_500 },
      spreadTicks: 1,
      mid: 100.375,
      bookValid: true,
    });
    expect(top.history).toHaveLength(2);
    expect(await feed.topOfBook(C)).not.toHaveProperty("history");
  });

  it("computes quote OFI per minute from best bid/ask changes, restarting after a reset", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    clock.t = M0 + MINUTE_MS;
    hub.depth(C, book(100, 10, 100.25, 8));
    hub.depth(C, [{ timestamp: iso(T0), type: DOM_TYPE.Bid, price: 100, volume: 15 }]); // +5
    hub.depth(C, [{ timestamp: iso(T0), type: DOM_TYPE.Trade, price: 100, volume: 1 }]); // no L1 change
    hub.depth(C, [
      { timestamp: iso(T0), type: DOM_TYPE.NewBestBid, price: 100.25, volume: 3 },
      { timestamp: iso(T0), type: DOM_TYPE.NewBestAsk, price: 100.5, volume: 6 },
    ]); // +3 +8
    hub.depth(C, [{ timestamp: iso(T0), type: DOM_TYPE.Reset }]);
    hub.depth(C, book(90, 1, 95, 1)); // no OFI across the reset
    clock.t = M0 + 2 * MINUTE_MS + 5_000;
    const [r] = feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS);
    expect(r.ofiQuote).toBe(16);
    const top = await feed.topOfBook(C, 100);
    expect(top.history!.map((e) => [e.bid, e.bidSize, e.ask, e.askSize])).toEqual([
      [100, 10, 100.25, 8],
      [100, 15, 100.25, 8],
      [100.25, 3, 100.5, 6],
      [90, 1, 95, 1],
    ]);
  });

  it("time-averages the book imbalance over the minute", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    clock.t = M0 + MINUTE_MS;
    hub.depth(C, book(100, 3, 100.25, 1)); // (3-1)/4 = 0.5
    clock.t = M0 + MINUTE_MS + 30_000;
    hub.depth(C, [{ timestamp: iso(T0), type: DOM_TYPE.Ask, price: 100.25, volume: 3 }]); // 0
    clock.t = M0 + 2 * MINUTE_MS + 30_000;
    const [r1, r2] = feed.records(C, M0 + MINUTE_MS, M0 + 2 * MINUTE_MS);
    expect(r1.bookImbalance).toBeCloseTo(0.25, 12);
    expect(r2.bookImbalance).toBe(0);
    expect(feed.records(C, M0, M0)[0].bookImbalance).toBeNull();
  });

  it("L2 depth: levels best first with cumulative size, spread, imbalance, age, and a capped change history", async () => {
    const { hub, feed, clock } = make();
    await feed.ensure(C);
    hub.depth(C, [
      { timestamp: iso(T0), type: DOM_TYPE.Bid, price: 100, volume: 5 },
      { timestamp: iso(T0), type: DOM_TYPE.Bid, price: 99.75, volume: 3 },
      { timestamp: iso(T0), type: DOM_TYPE.Bid, price: 99.5, volume: 2 },
      { timestamp: iso(T0), type: DOM_TYPE.Ask, price: 100.5, volume: 4 },
      { timestamp: iso(T0), type: DOM_TYPE.Ask, price: 100.75, volume: 1 },
    ]);
    clock.t += 1_500;
    const d = await feed.depth(C, { levels: 2, imbalanceLevels: 1, history: 3 });
    expect(d).toMatchObject({
      valid: true,
      ageMs: 1_500,
      lastUpdate: iso(T0),
      bestBid: { price: 100, size: 5 },
      bestAsk: { price: 100.5, size: 4 },
      spreadTicks: 2,
      imbalance: (5 - 4) / 9,
      totalLevels: { bids: 3, asks: 2 },
      bids: [{ price: 100, size: 5, cumSize: 5 }, { price: 99.75, size: 3, cumSize: 8 }],
      asks: [{ price: 100.5, size: 4, cumSize: 4 }, { price: 100.75, size: 1, cumSize: 5 }],
    });
    expect(d.history!.map((h) => [h.side, h.price, h.size, h.prevSize])).toEqual([["bid", 99.5, 2, 0], ["ask", 100.5, 4, 0], ["ask", 100.75, 1, 0]]);
    for (let i = 0; i < FLOW_LIMITS.depthChanges + 5; i++) hub.depth(C, [{ timestamp: iso(T0), type: DOM_TYPE.Ask, price: 101, volume: (i % 2) + 1 }]);
    const all = await feed.depth(C, { levels: 1, imbalanceLevels: 5, history: FLOW_LIMITS.depthChanges + 100 });
    expect(all.history).toHaveLength(FLOW_LIMITS.depthChanges);
    expect(FLOW_LIMITS.depthChanges).toBe(20_000);
  });

  it("depth and top of book have no spread without a tick size", async () => {
    const { hub, feed } = make({ ticks: { get: async () => { throw new Error("down"); } } });
    await feed.ensure(C);
    hub.depth(C, book(100, 1, 100.25, 1));
    expect((await feed.depth(C, { levels: 5, imbalanceLevels: 5 })).spreadTicks).toBeNull();
    expect((await feed.topOfBook(C)).spreadTicks).toBeNull();
    const noTicks = make({ ticks: undefined });
    await noTicks.feed.ensure(C);
    expect(await noTicks.feed.tickSize(C)).toBeNull();
  });

  it("keeps a bounded print buffer with limit and since", async () => {
    const { hub, feed } = make();
    await feed.ensure(C);
    for (let i = 0; i < FLOW_LIMITS.prints + 10; i++) hub.trade(C, trade(T0 + i, 100, 1, i % 2));
    const all = feed.prints(C, { limit: 1_000_000 });
    expect(all).toHaveLength(FLOW_LIMITS.prints);
    expect(all[0].t).toBe(T0 + 10);
    expect(feed.prints(C, { limit: 2 }).map((p) => p.t)).toEqual([T0 + FLOW_LIMITS.prints + 8, T0 + FLOW_LIMITS.prints + 9]);
    expect(feed.prints(C, { limit: 100, since: T0 + FLOW_LIMITS.prints + 7 })).toHaveLength(3);
  });
});

describe("FlowFeed roll", () => {
  // 17:00 CT on 2026-10-12 is 22:00 UTC.
  const S = Date.UTC(2026, 9, 12, 22, 0);
  const OLD = "CON.F.US.MNQ.Z26";
  const NEW = "CON.F.US.MNQ.H27";

  it("resolves symbols at start and again at the trading-day start, switching contracts on a roll", async () => {
    let active = OLD;
    const { hub, feed, clock, warnings } = make({ resolve: async (s) => (s === "MNQ" ? active : null) });
    feed.setSymbols(["mnq"]);
    await feed.tick();
    expect(feed.bySymbol.get("MNQ")).toBe(OLD);
    expect(hub.subscribes()).toEqual([`trades:${OLD}`, `depth:${OLD}`, `quotes:${OLD}`]);
    active = NEW;
    clock.t = S - 1_000;
    await feed.tick(); // same trading day: no re-resolve
    expect(feed.bySymbol.get("MNQ")).toBe(OLD);
    clock.t = S + 1_000;
    await feed.tick();
    expect(feed.bySymbol.get("MNQ")).toBe(NEW);
    expect(feed.contracts()).toEqual([NEW]);
    expect(hub.calls.filter(([op]) => op === "unsubscribe").map(([, k, id]) => `${k}:${id}`)).toEqual([`trades:${OLD}`, `depth:${OLD}`, `quotes:${OLD}`]);
    expect(hub.subscribes("trades")).toEqual([`trades:${OLD}`, `trades:${NEW}`]);
    expect(warnings.some((w) => w.includes(`rolled from ${OLD} to ${NEW}`))).toBe(true);
  });

  it("retries a symbol that did not resolve, and warns", async () => {
    let calls = 0;
    const { feed, clock, warnings } = make({
      resolve: async () => {
        calls++;
        if (calls === 1) throw new Error("search down");
        return calls === 2 ? null : OLD;
      },
    });
    feed.setSymbols(["MNQ"]);
    await feed.tick();
    expect(warnings.some((w) => /resolving MNQ failed: search down/.test(w))).toBe(true);
    await feed.tick(); // before the retry time
    expect(calls).toBe(1);
    clock.t += RESOLVE_RETRY_MS;
    await feed.tick();
    expect(warnings.some((w) => /no active contract for MNQ/.test(w))).toBe(true);
    clock.t += RESOLVE_RETRY_MS;
    await feed.tick();
    expect(feed.contracts()).toEqual([OLD]);
    clock.t += RESOLVE_RETRY_MS;
    await feed.tick();
    expect(calls).toBe(3);
  });

  it("warns when a resolved symbol is over the cap", async () => {
    const { feed, warnings } = make({ maxContracts: 1, resolve: async (s) => `CON.F.US.${s}.Z26` });
    feed.setSymbols(["MNQ", "MES"]);
    await feed.tick();
    expect(feed.contracts()).toEqual(["CON.F.US.MNQ.Z26"]);
    expect(warnings.some((w) => /capped at 1/.test(w))).toBe(true);
  });

  it("does nothing without a resolver, and a maintenance failure is warned", async () => {
    const { feed, warnings } = make({ resolve: undefined });
    feed.setSymbols(["MNQ"]);
    await feed.tick();
    expect(feed.contracts()).toEqual([]);
    const bad = make({ now: () => { throw new Error("clock broke"); } });
    await bad.feed.tick();
    expect(bad.warnings.some((w) => /maintenance failed: clock broke/.test(w))).toBe(true);
    expect(warnings).toEqual([]);
    expect(FLOW_TICK_MS).toBe(5_000);
  });
});

describe("resolveActiveContract", () => {
  it("takes the active contract with the same root", async () => {
    const api = fakeApi({
      "/api/Contract/search": () => ({
        ...OK,
        contracts: [
          { id: "CON.F.US.MNQ.U26", activeContract: false },
          { id: "CON.F.US.MNQE.Z26", activeContract: true },
          { id: "CON.F.US.MNQ.Z26", activeContract: true },
        ],
      }),
    });
    expect(await resolveActiveContract(api, "mnq")).toBe("CON.F.US.MNQ.Z26");
    expect(api.bodiesFor("/api/Contract/search")).toEqual([{ searchText: "mnq", live: false }]);
    const none = fakeApi({ "/api/Contract/search": () => ({ ...OK, contracts: null }) });
    expect(await resolveActiveContract(none, "MNQ")).toBeNull();
  });
});

describe("FlowFeed liveness (silence, clock jumps, drops)", () => {
  it("a 1 h clock jump (sleep) records no complete minutes and is a gap from the last message", async () => {
    const { feed, clock, minutes, pump, hub } = make();
    await feed.ensure(C);
    await pump(M0 + 2 * MINUTE_MS + 30_000);
    const before = minutes.length;
    clock.t += 3600_000; // the process slept
    await feed.tick();
    hub.quote(C, { lastPrice: 1 }); // buffered pushes arrive after waking
    await pump(clock.t + 3 * MINUTE_MS);
    const emitted = minutes.slice(before).map(([, r]) => r.t);
    // Nothing from the slept hour (and the minute it started in) was emitted.
    expect(emitted.filter((t) => t < M0 + 3600_000 + 2 * MINUTE_MS)).toEqual([]);
    expect(emitted.length).toBeGreaterThan(0);
    const cov = feed.coverage(C);
    expect(cov.disconnects).toContain(iso(M0 + 2 * MINUTE_MS + 30_000));
    expect(cov.silences[0]).toEqual({ from: iso(M0 + 2 * MINUTE_MS + 30_000), to: iso(M0 + 2 * MINUTE_MS + 30_000 + 3600_000) });
  });

  it("the clock-jump rule alone splits the live interval at the last message", async () => {
    const { feed, clock, pump, warnings } = make();
    await feed.ensure(C);
    await pump(M0 + MINUTE_MS);
    clock.t += 3 * FLOW_TICK_MS;
    await feed.tick();
    expect(feed.coverage(C)).toMatchObject({ disconnects: [iso(M0 + MINUTE_MS)], liveSince: iso(M0 + MINUTE_MS + 3 * FLOW_TICK_MS) });
    expect(warnings.some((w) => /clock jumped 15 s/.test(w))).toBe(true);
    // A normal tick interval is not a jump.
    clock.t += FLOW_TICK_MS;
    await feed.tick();
    expect(feed.coverage(C).disconnects).toHaveLength(1);
  });

  it("a half-open socket: messages stop at :45, the drop is detected 30 s later, and that minute stays incomplete", async () => {
    const { feed, clock, pump, hub, minutes } = make();
    await feed.ensure(C);
    await pump(M0 + MINUTE_MS + 45_000);
    clock.t += 30_000; // nothing arrived; the hub notices only now
    hub.down();
    expect(feed.coverage(C).disconnects).toEqual([iso(M0 + MINUTE_MS + 45_000)]);
    hub.resubscribed("trades", C);
    await pump(clock.t + 3 * MINUTE_MS);
    const done = minutes.map(([, r]) => r.t);
    expect(done).not.toContain(M0 + MINUTE_MS);
    expect(done).toContain(M0 + 3 * MINUTE_MS);
  });

  it("genuinely quiet minutes (flat quote volume, no prints) complete; total silence does not", async () => {
    const { feed, clock, pump, minutes } = make();
    await feed.ensure(C);
    await pump(M0 + 3 * MINUTE_MS + 12_000); // quotes with a flat session volume, no trades
    expect(minutes.map(([, r]) => [r.t, r.volume])).toEqual([[M0 + MINUTE_MS, 0], [M0 + 2 * MINUTE_MS, 0]]);
    clock.t = M0 + 6 * MINUTE_MS + 5_000; // silence: no message at all
    await feed.tick();
    await pump(M0 + 8 * MINUTE_MS + 12_000);
    const later = minutes.map(([, r]) => r.t).filter((t) => t >= M0 + 3 * MINUTE_MS);
    expect(later).toEqual([M0 + 7 * MINUTE_MS]);
    expect(feed.records(C, M0 + 4 * MINUTE_MS, M0 + 4 * MINUTE_MS)[0].complete).toBe(false);
  });

  it("ignores prints replayed on resubscribe (before the new live interval)", async () => {
    const { feed, clock, pump, hub } = make();
    await feed.ensure(C);
    await pump(M0 + 40_000);
    hub.trade(C, trade(M0 + 40_000, 100, 3, 0));
    hub.down();
    clock.t = M0 + 41_000;
    hub.resubscribed("trades", C);
    hub.trade(C, [trade(M0 + 40_000, 100, 3, 0), trade(M0 + 41_000, 100, 1, 1)]); // the first is a replay
    expect(feed.coverage(C).replayedPrints).toBe(1);
    expect(feed.records(C, M0, M0)[0]).toMatchObject({ bv: 3, sv: 1 });
    hub.down();
    hub.trade(C, trade(M0 + 39_000, 100, 9, 0)); // while down: before the drop, already covered
    expect(feed.coverage(C).replayedPrints).toBe(2);
  });

  it("extends the finalization grace by the measured print delay, capped", async () => {
    const { feed, clock, pump, hub } = make();
    await feed.ensure(C);
    for (let i = 0; i < 5; i++) {
      await pump(M0 + 20_000 + i * 2_000);
      hub.trade(C, trade(clock.t - 6_000, 100, 1, i % 2)); // arrive 6 s late
    }
    expect(feed.coverage(C)).toMatchObject({ graceMs: 8_000, settleMs: 16_000, skewMs: 6_000 });
    await pump(M0 + 2 * MINUTE_MS + 15_000);
    expect(feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS)[0].complete).toBe(false); // no trade after: needs end + 16 s
    await pump(M0 + 2 * MINUTE_MS + 16_000);
    expect(feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS)[0].complete).toBe(true);
    for (let i = 0; i < 9; i++) {
      await pump(clock.t + 1_000);
      hub.trade(C, trade(clock.t - 50_000, 100, 1, 0)); // 50 s late
    }
    expect(feed.coverage(C)).toMatchObject({ graceMs: 12_000, settleMs: 20_000 });
  });

  it("a print for a finalized minute is counted as late, warned once, and never changes it", async () => {
    const { feed, pump, hub, minutes, warnings } = make();
    await feed.ensure(C);
    await pump(M0 + 2 * MINUTE_MS + 12_000);
    const before = feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS)[0];
    expect(before.complete).toBe(true);
    hub.trade(C, [trade(M0 + 115_000, 100, 4, 0), trade(M0 + 116_000, 100, 4, 0)]);
    expect(feed.coverage(C).latePrints).toBe(2);
    expect(feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS)[0]).toEqual(before);
    expect(warnings.filter((w) => /after its minute was final/.test(w))).toHaveLength(1);
    expect(minutes.filter(([, r]) => r.t === M0 + MINUTE_MS)).toHaveLength(1);
  });

  it("a sideless print makes its minute incomplete and is warned once", async () => {
    const { feed, pump, hub, minutes, warnings } = make();
    await feed.ensure(C);
    await pump(M0 + 70_000);
    hub.trade(C, [trade(M0 + 70_000, 100, 2, 3), trade(M0 + 70_000, 100, 1, 2), trade(M0 + 70_000, 100, 1, 0)]);
    await pump(M0 + 3 * MINUTE_MS + 12_000);
    expect(minutes.map(([, r]) => r.t)).toEqual([M0 + 2 * MINUTE_MS]);
    expect(feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS)[0]).toMatchObject({ complete: false, sidelessVolume: 3, bv: 1 });
    expect(feed.coverage(C).sidelessVolume).toBe(3);
    expect(warnings.filter((w) => /no known aggressor side/.test(w))).toHaveLength(1);
  });

  it("a print with a bad timestamp makes its (receive) minute incomplete", async () => {
    const { feed, pump, hub, minutes } = make();
    await feed.ensure(C);
    await pump(M0 + 70_000);
    hub.trade(C, { price: 100, volume: 1, type: 0, timestamp: "2026-10-12T14:31:10" }); // no offset
    await pump(M0 + 3 * MINUTE_MS + 12_000);
    expect(minutes.map(([, r]) => r.t)).toEqual([M0 + 2 * MINUTE_MS]);
    expect(feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS)[0]).toMatchObject({ complete: false, badTimestamps: 1, bv: 1 });
  });

  it("a repeated subscribe confirmation does not start a second interval", async () => {
    const { feed, clock, hub } = make();
    await feed.ensure(C);
    clock.t += 5_000;
    hub.resubscribed("trades", C);
    hub.resubscribed("trades", C);
    expect(feed.coverage(C)).toMatchObject({ liveSince: iso(T0), disconnects: [] });
  });

  it("uses only a two-sided book for L1, quote OFI and imbalance; a one-sided book is partial", async () => {
    const { feed, clock, hub } = make();
    await feed.ensure(C);
    clock.t = M0 + MINUTE_MS;
    hub.depth(C, [{ timestamp: iso(clock.t), type: DOM_TYPE.Bid, price: 100, volume: 5 }]);
    hub.depth(C, [{ timestamp: iso(clock.t), type: DOM_TYPE.Bid, price: 100, volume: 7 }]);
    const d = await feed.depth(C, { levels: 5, imbalanceLevels: 5 });
    expect(d).toMatchObject({ valid: false, partial: true, snapshot: false, imbalance: null, bids: [{ price: 100, size: 7, cumSize: 7 }] });
    expect((await feed.topOfBook(C, 10)).history).toEqual([]);
    clock.t += 30_000;
    hub.depth(C, [{ timestamp: iso(clock.t), type: DOM_TYPE.Ask, price: 100.25, volume: 7 }]);
    clock.t = M0 + 2 * MINUTE_MS;
    const [r] = feed.records(C, M0 + MINUTE_MS, M0 + MINUTE_MS);
    // Imbalance only over the 30 s with both sides (0), OFI from the first two-sided state on (none).
    expect(r.bookImbalance).toBe(0);
    expect(r.ofiQuote).toBe(0);
    expect((await feed.depth(C, { levels: 5, imbalanceLevels: 5 })).valid).toBe(true);
  });
});

describe("FlowFeed contract checks", () => {
  it("refuses unknown contracts before subscribing, so they never use up the cap", async () => {
    const { feed, hub } = make({ maxContracts: 2, validate: async (id) => (id.startsWith("BAD") ? false : id === "MAYBE" ? null : true) });
    await expect(feed.ensure("BAD1")).rejects.toThrow(/Unknown contract BAD1/);
    await expect(feed.ensure("BAD2")).rejects.toThrow(/Unknown contract BAD2/);
    await feed.ensure(C);
    await feed.ensure("MAYBE"); // could not tell: allowed
    expect(feed.contracts()).toEqual([C, "MAYBE"]);
    expect(hub.subscribes().filter((x) => x.includes("BAD"))).toEqual([]);
    const throwing = make({ validate: async () => { throw new Error("down"); } });
    await throwing.feed.ensure(C);
    expect(throwing.feed.contracts()).toEqual([C]);
  });

  it("in MCP mode forgets a contract whose first trade subscribe failed and does not retry it", async () => {
    const { feed, hub } = make({ maxContracts: 2 });
    hub.fail = (_k, id) => (id.startsWith("BAD") ? new Error("no such contract") : null);
    await expect(feed.ensure("BAD1")).rejects.toThrow(/Could not subscribe to BAD1: no such contract/);
    await expect(feed.ensure("BAD2")).rejects.toThrow(/Could not subscribe to BAD2/);
    await feed.ensure(C);
    expect(feed.contracts()).toEqual([C]);
    const n = hub.subscribes().length;
    await feed.tick();
    expect(hub.subscribes().length).toBe(n);
  });

  it("the recorder keeps a contract whose subscribe failed and retries it", async () => {
    const { feed, hub } = make({ dropFailedSubscribes: false });
    hub.fail = () => new Error("hub busy");
    await feed.ensure(C);
    expect(feed.contracts()).toEqual([C]);
    hub.fail = () => null;
    await feed.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.coverage(C).tradesLive).toBe(true);
  });

  it("contractExists asks Contract/searchById", async () => {
    const { contractExists } = await import("../src/flowfeed.js");
    const ok = fakeApi({ "/api/Contract/searchById": () => ({ ...OK, contract: { id: C } }) });
    expect(await contractExists(ok, C)).toBe(true);
    expect(ok.calls[0].opts).toMatchObject({ allowFailure: true });
    expect(await contractExists(fakeApi({ "/api/Contract/searchById": () => ({ ...OK, contract: null }) }), C)).toBe(false);
    expect(await contractExists(fakeApi({ "/api/Contract/searchById": () => ({ success: false, errorCode: 1, errorMessage: "x" }) }), C)).toBe(false);
    expect(await contractExists(fakeApi({}), C)).toBeNull();
  });
});

describe("FlowFeed trade-feed cross-check and clock skew", () => {
  it("quotes with rising volume but no trades for 10 min: no complete minutes, counted and warned once", async () => {
    const { feed, clock, hub, minutes, warnings } = make();
    await feed.ensure(C);
    let v = 5000;
    while (clock.t < M0 + 11 * MINUTE_MS) {
      clock.t += 2_000;
      v += 3; // the market trades; the trade subscription delivers nothing
      hub.quote(C, { lastPrice: 100, volume: v });
      await feed.tick();
    }
    expect(minutes).toEqual([]);
    expect(feed.records(C, M0 + MINUTE_MS, M0 + 9 * MINUTE_MS).every((r) => !r.complete)).toBe(true);
    expect(feed.coverage(C).tradeFeedMismatch).toBeGreaterThanOrEqual(9);
    expect(warnings.filter((w) => /quote feed shows trading/.test(w))).toHaveLength(1);
  });

  it("a last-price change with no print makes the minute incomplete", async () => {
    const { feed, clock, hub, minutes } = make();
    await feed.ensure(C);
    let price = 100;
    while (clock.t < M0 + 3 * MINUTE_MS + 12_000) {
      clock.t += 2_000;
      if (clock.t > M0 + MINUTE_MS + 30_000 && clock.t < M0 + MINUTE_MS + 33_000) price = 100.25;
      hub.quote(C, { lastPrice: price, volume: 1000 });
      await feed.tick();
    }
    expect(minutes.map(([, r]) => r.t)).toEqual([M0 + 2 * MINUTE_MS]);
  });

  it("prints matching the quote volume change complete the minute; more volume than prints does not", async () => {
    const { feed, clock, hub, minutes } = make();
    await feed.ensure(C);
    const q = (volume: number) => hub.quote(C, { lastPrice: 100, volume });
    const step = async (until: number, volume: number) => {
      while (clock.t < until) {
        clock.t += 2_000;
        q(volume);
        await feed.tick();
      }
    };
    await step(M0 + MINUTE_MS + 20_000, 1000);
    hub.trade(C, [trade(clock.t, 100, 3, 0), trade(clock.t, 100, 2, 1)]); // 5 contracts
    await step(M0 + 2 * MINUTE_MS + 20_000, 1005); // matches
    hub.trade(C, trade(clock.t, 100, 1, 0)); // 1 contract, but the quote volume rises by 10
    await step(M0 + 3 * MINUTE_MS + 12_000, 1015);
    expect(minutes.map(([, r]) => [r.t, r.bv, r.sv])).toEqual([[M0 + MINUTE_MS, 3, 2]]);
  });

  it("without quote volume a zero-print minute is incomplete, a minute with prints can complete", async () => {
    const { feed, clock, hub, minutes } = make();
    await feed.ensure(C);
    while (clock.t < M0 + 3 * MINUTE_MS + 12_000) {
      clock.t += 2_000;
      hub.quote(C, { lastPrice: 100 }); // no volume field
      if (clock.t === M0 + 2 * MINUTE_MS + 20_000) hub.trade(C, trade(clock.t, 100, 1, 0));
      await feed.tick();
    }
    expect(minutes.map(([, r]) => r.t)).toEqual([M0 + 2 * MINUTE_MS]);
  });

  it.each([1_000, 3_000])("a local clock 3 s behind the exchange holds the first minute incomplete (subscribed %i ms before it), and is warned once", async (early) => {
    const hub = fakeFlowHub();
    const clock = fakeClock(M0 - early); // subscribe at local M0 - early
    const warnings: string[] = [];
    const feed = new FlowFeed({ hub, now: clock.now, warn: (l) => void warnings.push(l), timers: manualTimers() });
    await feed.ensure(C);
    let v = 1000;
    while (clock.t < M0 + MINUTE_MS + 11_000) {
      clock.t += 1_000;
      hub.quote(C, { lastPrice: 100, volume: v });
      // Exchange timestamps run 3 s ahead of this machine.
      if (clock.t % 10_000 === 0) {
        hub.trade(C, { price: 100, volume: 1, type: 0, timestamp: iso(clock.t + 3_000) });
        v += 1;
      }
      await feed.tick();
    }
    expect(feed.coverage(C).skewMs).toBe(-3_000);
    expect(feed.records(C, M0, M0)[0].complete).toBe(false);
    expect(warnings.filter((w) => /clock is behind the exchange/.test(w))).toHaveLength(1);
  });

  it("with clocks in step, subscribing 3 s before the minute completes it", async () => {
    const hub = fakeFlowHub();
    const clock = fakeClock(M0 - 3_000);
    const feed = new FlowFeed({ hub, now: clock.now, warn: () => {}, timers: manualTimers() });
    await feed.ensure(C);
    let v = 1000;
    while (clock.t < M0 + MINUTE_MS + 11_000) {
      clock.t += 1_000;
      if (clock.t % 10_000 === 0) {
        hub.trade(C, { price: 100, volume: 1, type: 0, timestamp: iso(clock.t) });
        v += 1;
      }
      hub.quote(C, { lastPrice: 100, volume: v });
      await feed.tick();
    }
    expect(feed.records(C, M0, M0)[0].complete).toBe(true);
  });
});

describe("FlowFeed quote volume across a minute boundary", () => {
  const STRADDLE = M0 + 2 * MINUTE_MS - 500; // a print 0.5 s before the boundary; its quote update arrives 1 s later

  it("a 5-lot straddle with a quiet next minute: both minutes complete", async () => {
    const { feed, hub, minutes, pump, setLag } = make();
    setLag(1_000);
    await feed.ensure(C);
    await pump(STRADDLE, [C], 500);
    hub.trade(C, trade(STRADDLE, 101, 5, 0));
    await pump(M0 + 3 * MINUTE_MS + 12_000, [C], 500);
    expect(minutes.map(([, r]) => [r.t, r.bv])).toEqual([[M0 + MINUTE_MS, 5], [M0 + 2 * MINUTE_MS, 0]]);
    expect(feed.coverage(C).tradeFeedMismatch).toBe(0);
  });

  it("a 10-lot straddle with 30 in the next minute: complete", async () => {
    const { feed, hub, minutes, pump, setLag } = make();
    setLag(1_000);
    await feed.ensure(C);
    await pump(STRADDLE, [C], 500);
    hub.trade(C, trade(STRADDLE, 100, 10, 0));
    await pump(M0 + 2 * MINUTE_MS + 30_000, [C], 500);
    hub.trade(C, trade(M0 + 2 * MINUTE_MS + 30_000, 100, 30, 1));
    await pump(M0 + 3 * MINUTE_MS + 12_000, [C], 500);
    expect(minutes.map(([, r]) => [r.t, r.bv, r.sv])).toEqual([[M0 + MINUTE_MS, 10, 0], [M0 + 2 * MINUTE_MS, 0, 30]]);
  });

  it("a dead trade feed still shows up despite the carry", async () => {
    const { feed, hub, clock, minutes, pump, setLag } = make();
    setLag(1_000);
    await feed.ensure(C);
    await pump(STRADDLE, [C], 500);
    hub.trade(C, trade(STRADDLE, 100, 5, 0));
    await pump(M0 + 2 * MINUTE_MS + 2_000, [C], 500);
    // The trade subscription dies; the quote volume keeps rising for several minutes.
    let v = 1005;
    while (clock.t < M0 + 6 * MINUTE_MS + 12_000) {
      clock.t += 2_000;
      v += 1;
      hub.quote(C, { lastPrice: 100, volume: v });
      await feed.tick();
    }
    expect(minutes.map(([, r]) => r.t)).toEqual([M0 + MINUTE_MS]);
    expect(feed.coverage(C).tradeFeedMismatch).toBeGreaterThanOrEqual(4);
  });

  it("the carry does not cross a disconnect", async () => {
    const { feed, hub, clock, minutes, pump, setLag } = make();
    setLag(1_000);
    await feed.ensure(C);
    await pump(M0 + 2 * MINUTE_MS + 30_000, [C], 500);
    hub.down();
    clock.t += 500;
    hub.resubscribed("trades", C);
    await pump(STRADDLE + MINUTE_MS, [C], 500);
    hub.trade(C, trade(STRADDLE + MINUTE_MS, 100, 5, 0)); // minute 2's print, its quote update lands in minute 3
    await pump(M0 + 4 * MINUTE_MS + 12_000, [C], 500);
    // Minute 2 touched the drop; minute 3 may not borrow its shortfall, so the shifted volume is unexplained.
    expect(minutes.map(([, r]) => r.t)).toEqual([M0 + MINUTE_MS]);
    expect(feed.coverage(C).tradeFeedMismatch).toBe(1);
  });

  it("a lastPrice change right after the boundary to the previous minute's last print price is not a mismatch; later or other prices are", async () => {
    const { feed, hub, minutes, pump, setLag } = make();
    setLag(1_000);
    await feed.ensure(C);
    await pump(STRADDLE, [C], 500);
    hub.trade(C, trade(STRADDLE, 101, 5, 0));
    await pump(M0 + 3 * MINUTE_MS + 12_000, [C], 500);
    expect(minutes.map(([, r]) => r.t)).toContain(M0 + 2 * MINUTE_MS);
    const slow = make();
    slow.setLag(3_000); // the quote catches up 2.5 s after the boundary: past max(1 s, median delay)
    await slow.feed.ensure(C);
    await slow.pump(STRADDLE, [C], 500);
    slow.hub.trade(C, trade(STRADDLE, 101, 5, 0));
    await slow.pump(M0 + 3 * MINUTE_MS + 12_000, [C], 500);
    expect(slow.minutes.map(([, r]) => r.t)).toEqual([M0 + MINUTE_MS]);
  });
});

describe("FlowFeed carry limits", () => {
  /** Drive minute by minute: quotes every 500 ms with the given volume/price functions of time, trades pushed by `at`. */
  async function drive(o: { until: number; vol: (t: number) => number; price?: (t: number) => number; trades?: Array<[number, number, number, number]> }) {
    const h = make();
    await h.feed.ensure(C);
    const trades = [...(o.trades ?? [])];
    while (h.clock.t < o.until) {
      h.clock.t += 500;
      while (trades.length && trades[0][0] <= h.clock.t) {
        const [recv, exch, size, price] = trades.shift()!;
        void recv;
        h.hub.trade(C, { price, volume: size, type: 0, timestamp: iso(exch) });
      }
      h.hub.quote(C, { lastPrice: o.price ? o.price(h.clock.t) : 100, volume: o.vol(h.clock.t) });
      await h.feed.tick();
    }
    return h;
  }
  const M1 = M0 + MINUTE_MS;
  const M2 = M0 + 2 * MINUTE_MS;

  it("the carry covers only the lag window: volume traded late in a dead-feed minute is flagged", async () => {
    // Minute 1: 40 printed, the quote rose by 20 only (shortfall 20). Then the trade feed dies; 20 trade at 2:50.
    const trades: Array<[number, number, number, number]> = [[M1 + 30_000, M1 + 30_000, 40, 100]];
    const h = await drive({ until: M0 + 3 * MINUTE_MS + 12_000, trades, vol: (t) => 1000 + (t >= M1 + 30_000 ? 20 : 0) + (t >= M2 + 50_000 ? 20 : 0) });
    expect(h.minutes.map(([, r]) => r.t)).toEqual([M1]);
  });

  it("no carry when the previous minute's quote volume matched its prints", async () => {
    // Minute 1: 5 printed, quote +5. Minute 2: dead feed, the quote rises 3 right after the boundary.
    const trades: Array<[number, number, number, number]> = [[M1 + 30_000, M1 + 30_000, 5, 100]];
    const h = await drive({ until: M0 + 3 * MINUTE_MS + 12_000, trades, vol: (t) => 1000 + (t >= M1 + 30_000 ? 5 : 0) + (t >= M2 + 500 ? 3 : 0) });
    expect(h.minutes.map(([, r]) => r.t)).toEqual([M1]);
  });

  it("an early lastPrice change to a price other than the previous minute's last print is flagged", async () => {
    const trades: Array<[number, number, number, number]> = [[M1 + 30_000, M1 + 30_000, 5, 101]];
    const h = await drive({
      until: M0 + 3 * MINUTE_MS + 12_000,
      trades,
      vol: (t) => 1000 + (t >= M1 + 30_000 ? 5 : 0),
      price: (t) => (t >= M2 + 500 ? 102 : t >= M1 + 30_000 ? 101 : 100),
    });
    expect(h.minutes.map(([, r]) => r.t)).toEqual([M1]);
    const same = await drive({
      until: M0 + 3 * MINUTE_MS + 12_000,
      trades,
      vol: (t) => 1000 + (t >= M1 + 30_000 ? 5 : 0),
      price: (t) => (t >= M2 + 500 ? 101 : t >= M1 + 30_000 ? 100 : 100), // the quote catches up to 101 just after the boundary
    });
    expect(same.minutes.map(([, r]) => r.t)).toEqual([M1, M2]);
  });

  it("with prints in the minute, the carry still covers only the rise within the lag window", async () => {
    // Minute 1: 40 printed, quote +20 (shortfall 20). Minute 2: 5 printed and matched, plus 20 more quote volume late in the minute.
    const trades: Array<[number, number, number, number]> = [[M1 + 30_000, M1 + 30_000, 40, 100], [M2 + 30_000, M2 + 30_000, 5, 100]];
    const h = await drive({
      until: M0 + 3 * MINUTE_MS + 12_000,
      trades,
      vol: (t) => 1000 + (t >= M1 + 30_000 ? 20 : 0) + (t >= M2 + 30_000 ? 5 : 0) + (t >= M2 + 50_000 ? 20 : 0),
    });
    expect(h.minutes.map(([, r]) => r.t)).toEqual([M1]);
  });

  it("the lastPrice exception uses the same capped window", async () => {
    // Prints arrive 8 s late; minute 1's last print (101, exchange 1:57) arrives at 2:05, the quote's lastPrice follows at `at`.
    const run = async (at: number) => {
      const recvs: number[] = [];
      for (let r = M0 + 25_000; r <= M2 + 5_000; r += 10_000) recvs.push(r);
      const trades = recvs.map((r): [number, number, number, number] => [r, r - 8_000, 1, r === M2 + 5_000 ? 101 : 100]);
      const counted = recvs.filter((r) => r - 8_000 >= M1);
      return drive({
        until: M0 + 3 * MINUTE_MS + 25_000,
        trades,
        vol: (t) => 1000 + counted.filter((r) => r <= t).length,
        price: (t) => (t >= at ? 101 : 100),
      });
    };
    expect((await run(M2 + 5_000)).minutes.map(([, r]) => r.t)).toEqual([M1, M2]);
    expect((await run(M2 + 6_000)).minutes.map(([, r]) => r.t)).toEqual([M1]);
  });

  it("caps the lag window at 5 s even when prints arrive 8 s late", async () => {
    expect(lagWindowMs(0)).toBe(1_000);
    expect(lagWindowMs(3_000)).toBe(3_000);
    expect(lagWindowMs(8_000)).toBe(MAX_LAG_WINDOW_MS);
    expect(MAX_LAG_WINDOW_MS).toBe(5_000);
    // Prints every 10 s arrive 8 s after their exchange time; quotes follow each print on arrival,
    // except the last one of minute 1 (arrives 2:05), whose quote update comes at 2:06: outside the 5 s window.
    const recvs: number[] = [];
    for (let r = M0 + 25_000; r <= M2 + 5_000; r += 10_000) recvs.push(r);
    const trades = recvs.map((r): [number, number, number, number] => [r, r - 8_000, 1, 100]);
    const counted = recvs.filter((r) => r - 8_000 >= M1);
    const vol = (t: number) => 1000 + counted.filter((r) => (r === M2 + 5_000 ? r + 1_000 : r) <= t).length;
    const h = await drive({ until: M0 + 3 * MINUTE_MS + 25_000, trades, vol });
    expect(h.feed.coverage(C).skewMs).toBe(8_000);
    expect(h.minutes.map(([, r]) => r.t)).toEqual([M1]);
  });
});
