import { describe, expect, it } from "vitest";
import {
  Book,
  DOM_TYPE,
  FINALIZE_GRACE_MS,
  MAX_BOOK_LEVELS,
  MINUTE_MS,
  Ring,
  TRADE_SIDE_BY_TYPE,
  addPrint,
  csvLine,
  cumulativeDeltas,
  footprintBar,
  gapsOf,
  mergeRecords,
  RECORDER_GRACE_MS,
  SILENCE_LIMIT_MS,
  median,
  settlePoint,
  tradeFeedCheck,
  minuteComplete,
  minuteDecided,
  newBucket,
  ofiEvent,
  parseDepth,
  parseRecordLine,
  parseTimestamp,
  parseTrades,
  quoteOfi,
  recordLine,
  recordOf,
  rowOf,
  type L1Event,
  type MinuteRecord,
} from "../src/orderflow.js";

const T = Date.UTC(2026, 9, 12, 14, 30); // a minute start
const iso = (t: number) => new Date(t).toISOString();

function rec(t: number, o: Partial<MinuteRecord> = {}): MinuteRecord {
  return { t, bv: 0, sv: 0, volume: 0, trades: 0, vwap: null, high: null, low: null, maxPrint: null, sizes: [], vap: [], ofiQuote: null, bookImbalance: null, badTimestamps: 0, sidelessVolume: 0, complete: true, source: "live", ...o };
}

describe("payload parsing", () => {
  it("maps trade type 0 to buy and 1 to sell; other types have no side", () => {
    expect(TRADE_SIDE_BY_TYPE).toEqual({ 0: "buy", 1: "sell" });
    const p = parseTrades(
      [
        { symbolId: "F.US.MNQ", price: 100, timestamp: iso(T + 1000), type: 0, volume: 2 },
        { price: 100.25, timestamp: iso(T + 2000), type: 1, volume: 3 },
        { price: 101, timestamp: iso(T + 3000), type: 7, volume: 1 },
      ],
      T + 5000,
    );
    expect(p.items.map((i) => i.side)).toEqual(["buy", "sell", null]);
    expect(p.items[0].t).toBe(T + 1000);
  });

  it("accepts a single trade object and skips malformed items without throwing", () => {
    expect(parseTrades({ price: 5, volume: 1, type: 0, timestamp: iso(T) }, T).items).toHaveLength(1);
    const bad = parseTrades([null, 7, "x", { price: "1", volume: 1 }, { price: 1, volume: 0 }, { price: -1, volume: 1 }, [1]], T);
    expect(bad).toEqual({ items: [], skipped: 7, badTimestamps: 0 });
    expect(parseTrades(undefined, T).skipped).toBe(1);
  });

  it("uses the receive time for an unparseable or implausible timestamp, counts it and flags the print", () => {
    const p = parseTrades([{ price: 1, volume: 1, type: 0, timestamp: "garbage" }, { price: 1, volume: 1, type: 0 }, { price: 1, volume: 1, type: 0, timestamp: iso(T - 61_000) }], T);
    expect(p.items.map((i) => i.t)).toEqual([T, T, T]);
    expect(p.items.every((i) => i.badTimestamp === true)).toBe(true);
    expect(p.badTimestamps).toBe(3);
    expect(parseTimestamp(T - 5, T)).toEqual({ t: T - 5, bad: false });
    expect(parseTimestamp(iso(T - 59_000), T)).toEqual({ t: T - 59_000, bad: false });
    expect(parseTimestamp("2026-10-12T09:29:30-05:00", T)).toEqual({ t: T - 30_000, bad: false });
    expect(parseTimestamp("2026-10-12T14:29:30+0000", T)).toEqual({ t: T - 30_000, bad: false });
  });

  it("requires an explicit offset: a local time without one is bad, also when it happens to parse", () => {
    // The receive time written in this machine's local time without an offset: parses to the right instant, still bad.
    const d = new Date(T - 5_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    expect(Date.parse(local)).toBe(T - 5_000);
    expect(parseTimestamp(local, T)).toEqual({ t: T, bad: true });
    // 14:30 UTC written as local time in a UTC+10 zone, with and without its offset.
    expect(parseTimestamp("2026-10-13T00:30:00", T)).toEqual({ t: T, bad: true });
    expect(parseTimestamp("2026-10-13T00:30:00+10:00", T)).toEqual({ t: T, bad: false });
    // The same local time read as UTC is 10 h off: implausible.
    expect(parseTimestamp("2026-10-13T00:30:00Z", T)).toEqual({ t: T, bad: true });
    expect(parseTimestamp("2026-10-12T14:29:59", T).bad).toBe(true);
    expect(parseTrades({ price: 1, volume: 1, type: 0, timestamp: "2026-10-12T14:29:59" }, T).badTimestamps).toBe(1);
  });

  it("parses depth entries, keeps Reset without a price, skips malformed ones", () => {
    const d = parseDepth([{ timestamp: iso(T), type: 2, price: 100, volume: 5, currentVolume: 9 }, { type: 6 }, { type: 1, price: "x", volume: 1 }, { price: 1 }, null], T);
    expect(d.items).toEqual([
      { t: T, type: 2, price: 100, volume: 5 },
      { t: T, type: 6, price: 0, volume: 0, badTimestamp: true },
    ]);
    expect(d.skipped).toBe(3);
    expect(d.badTimestamps).toBe(1);
    expect(parseDepth({ type: 1, price: 1, volume: 1, timestamp: iso(T) }, T).items).toHaveLength(1);
  });
});

describe("Ring", () => {
  it("keeps the newest items up to its cap", () => {
    const r = new Ring<number>(3);
    expect(r.latest()).toBeUndefined();
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.last(2)).toEqual([4, 5]);
    expect(r.last(0)).toEqual([]);
    expect(r.latest()).toBe(5);
    expect(r.length).toBe(3);
    r.clear();
    expect(r.toArray()).toEqual([]);
  });
});

describe("Book", () => {
  const e = (type: number, price: number, volume: number) => ({ t: T, type, price, volume });

  it("maintains levels per side, removes zero-size levels and ignores trade-like types", () => {
    const b = new Book();
    expect(b.valid).toBe(false);
    expect(b.imbalance(5)).toBeNull();
    b.apply(e(DOM_TYPE.Bid, 100, 5), T);
    b.apply(e(DOM_TYPE.Bid, 99.75, 3), T);
    b.apply(e(DOM_TYPE.Ask, 100.25, 4), T);
    b.apply(e(DOM_TYPE.Ask, 100.5, 6), T);
    expect(b.valid).toBe(true);
    expect(b.best("bid")).toEqual({ price: 100, size: 5 });
    expect(b.best("ask")).toEqual({ price: 100.25, size: 4 });
    expect(b.imbalance(5)).toBeCloseTo((8 - 10) / 18, 12);
    expect(b.imbalance(1)).toBeCloseTo((5 - 4) / 9, 12);
    for (const t of [DOM_TYPE.Trade, DOM_TYPE.Fill, DOM_TYPE.Low, DOM_TYPE.High, DOM_TYPE.Unknown]) expect(b.apply(e(t, 50, 99), T + 1)).toEqual([]);
    expect(b.levels("bid")).toEqual([{ price: 100, size: 5 }, { price: 99.75, size: 3 }]);
    expect(b.lastUpdate).toBe(T + 1);
    const ch = b.apply(e(DOM_TYPE.Bid, 100, 0), T + 2);
    expect(ch).toEqual([{ t: T + 2, side: "bid", price: 100, size: 0, prevSize: 5, type: DOM_TYPE.Bid }]);
    expect(b.best("bid")).toEqual({ price: 99.75, size: 3 });
  });

  it("is valid only once both sides arrived; one side is partial; a Reset-led snapshot is flagged", () => {
    const b = new Book();
    b.apply(e(DOM_TYPE.Bid, 100, 5), T);
    expect(b).toMatchObject({ valid: false, partial: true, snapshot: false });
    expect(b.imbalance(5)).toBeNull();
    b.apply(e(DOM_TYPE.Ask, 100.25, 0), T); // a zero-size level is not a side seen
    expect(b.valid).toBe(false);
    b.apply(e(DOM_TYPE.Ask, 100.25, 4), T);
    expect(b).toMatchObject({ valid: true, partial: false, snapshot: false });
    b.apply({ t: T, type: DOM_TYPE.Reset, price: 0, volume: 0 }, T);
    expect(b).toMatchObject({ valid: false, partial: false });
    b.apply(e(DOM_TYPE.Ask, 100.25, 4), T);
    b.apply(e(DOM_TYPE.Bid, 100, 1), T);
    expect(b).toMatchObject({ valid: true, snapshot: true });
    b.clear();
    expect(b).toMatchObject({ valid: false, snapshot: false });
  });

  it("a BestBid/BestAsk with volume 0 removes that level only", () => {
    const b = new Book();
    b.apply(e(DOM_TYPE.Bid, 100, 5), T);
    b.apply(e(DOM_TYPE.Bid, 99.75, 3), T);
    b.apply(e(DOM_TYPE.Ask, 100.25, 4), T);
    b.apply(e(DOM_TYPE.BestBid, 100, 0), T);
    expect(b.levels("bid")).toEqual([{ price: 99.75, size: 3 }]);
    b.apply(e(DOM_TYPE.NewBestAsk, 100.25, 0), T);
    expect(b.levels("ask")).toEqual([]);
    expect(b.valid).toBe(true); // both sides were seen since the last reset
  });

  it("a new best bid/ask removes levels through it, and Reset clears and invalidates", () => {
    const b = new Book();
    b.apply(e(DOM_TYPE.Bid, 100, 5), T);
    b.apply(e(DOM_TYPE.NewBestBid, 100.25, 2), T);
    expect(b.best("bid")).toEqual({ price: 100.25, size: 2 });
    b.apply(e(DOM_TYPE.BestBid, 100, 1), T);
    expect(b.levels("bid")).toEqual([{ price: 100, size: 1 }]);
    b.apply(e(DOM_TYPE.Ask, 100.5, 1), T);
    b.apply(e(DOM_TYPE.Ask, 100.75, 1), T);
    b.apply(e(DOM_TYPE.NewBestAsk, 100.75, 3), T);
    expect(b.levels("ask")).toEqual([{ price: 100.75, size: 3 }]);
    b.apply(e(DOM_TYPE.BestAsk, 100.5, 2), T);
    expect(b.best("ask")).toEqual({ price: 100.5, size: 2 });
    const ch = b.apply({ t: T, type: DOM_TYPE.Reset, price: 0, volume: 0 }, T + 9);
    expect(ch[0]).toMatchObject({ side: null, type: DOM_TYPE.Reset });
    expect(b.valid).toBe(false);
    expect(b.bids.size + b.asks.size).toBe(0);
    expect(b.best("bid")).toBeNull();
  });

  it("caps each side, dropping the levels farthest from the best", () => {
    const b = new Book();
    for (let i = 0; i <= MAX_BOOK_LEVELS; i++) b.apply(e(DOM_TYPE.Bid, 1000 - i * 0.25, 1), T);
    expect(b.bids.size).toBe(MAX_BOOK_LEVELS);
    expect(b.bids.has(1000)).toBe(true);
    expect(b.bids.has(1000 - MAX_BOOK_LEVELS * 0.25)).toBe(false);
    for (let i = 0; i <= MAX_BOOK_LEVELS; i++) b.apply(e(DOM_TYPE.Ask, 2000 + i * 0.25, 1), T);
    expect(b.asks.size).toBe(MAX_BOOK_LEVELS);
    expect(b.asks.has(2000)).toBe(true);
  });
});

describe("quote OFI (Cont-Kukanov-Stoikov)", () => {
  const ev = (bid: number, bidSize: number, ask: number, askSize: number): L1Event => ({ t: T, bid, bidSize, ask, askSize, source: "depth" });

  it("matches a hand-computed example", () => {
    const events = [ev(100, 10, 100.25, 8), ev(100, 15, 100.25, 8), ev(100.25, 3, 100.5, 6), ev(100, 7, 100.25, 4)];
    // bid size up at the same price: +5; both up: +3 (new bid) + 8 (old ask); both down: -3 (old bid) - 4 (new ask)
    expect(ofiEvent(events[0], events[1])).toBe(5);
    expect(ofiEvent(events[1], events[2])).toBe(11);
    expect(ofiEvent(events[2], events[3])).toBe(-7);
    expect(quoteOfi(events)).toBe(9);
  });

  it("is null when a size is unknown (quote-sourced L1)", () => {
    const q: L1Event = { t: T, bid: 1, bidSize: null, ask: 2, askSize: null, source: "quote" };
    expect(ofiEvent(q, ev(1, 1, 2, 1))).toBeNull();
    expect(quoteOfi([q, ev(1, 1, 2, 1)])).toBe(0);
  });
});

describe("minute aggregation", () => {
  it("sums bv/sv/delta, vwap, high/low, max print and large prints at any threshold", () => {
    const b = newBucket(T + 5000);
    expect(b.t).toBe(T);
    for (const [price, size, side] of [[100, 2, "buy"], [100.25, 3, "sell"], [100.5, 12, "buy"], [100, 10, "sell"], [101, 1, null]] as const) {
      addPrint(b, { t: T, price, size, side });
    }
    const r = recordOf(b, true);
    const row = rowOf(r, 10, 7);
    // The sideless print counts in volume but not bv/sv, and makes the minute incomplete.
    expect(row).toMatchObject({ t: iso(T), bv: 14, sv: 13, delta: 1, volume: 28, trades: 5, high: 101, low: 100, maxPrint: 12, largeBuyVolume: 12, largeSellVolume: 10, cumDelta: 7, sidelessVolume: 1, complete: false, source: "live" });
    expect(row.vwap).toBeCloseTo(2807.75 / 28, 9);
    expect(row.ofiTrades).toBeCloseTo(1 / 27, 12);
    expect(rowOf(r, 11, null)).toMatchObject({ largeBuyVolume: 12, largeSellVolume: 0 });
    expect(rowOf(r, 13, null)).toMatchObject({ largeBuyVolume: 0, largeSellVolume: 0 });
    // Volume at price: [bid side (sell aggressor), ask side (buy aggressor)].
    expect(r.vap).toEqual([[100, 10, 2], [100.25, 3, 0], [100.5, 0, 12]]);
  });

  it("a print with a bad timestamp or no side makes its minute incomplete", () => {
    const ok = newBucket(T);
    addPrint(ok, { t: T, price: 1, size: 1, side: "buy" });
    expect(recordOf(ok, true).complete).toBe(true);
    expect(recordOf(ok, false).complete).toBe(false);
    const bad = newBucket(T);
    addPrint(bad, { t: T, price: 1, size: 1, side: "buy", badTimestamp: true });
    expect(recordOf(bad, true)).toMatchObject({ complete: false, badTimestamps: 1 });
    const sideless = newBucket(T);
    addPrint(sideless, { t: T, price: 1, size: 2, side: null });
    expect(recordOf(sideless, true)).toMatchObject({ complete: false, sidelessVolume: 2, bv: 0, sv: 0, volume: 2 });
  });

  it("an empty minute has zeros and nulls; OFI and imbalance are null without a book", () => {
    const row = rowOf(recordOf(newBucket(T), true), 10, null);
    expect(row).toMatchObject({ bv: 0, sv: 0, delta: 0, volume: 0, vwap: null, ofiTrades: null, ofiQuote: null, bookImbalance: null });
    const b = newBucket(T);
    b.imbArea = 0.5 * 30_000;
    b.imbMs = 30_000;
    expect(recordOf(b, true)).toMatchObject({ bookImbalance: 0.5, ofiQuote: 0 });
  });

  it("round-trips the recorder's JSONL line and writes the CSV line", () => {
    const b = newBucket(T);
    addPrint(b, { t: T, price: 100, size: 11, side: "buy" });
    addPrint(b, { t: T, price: 100.25, size: 2, side: "sell" });
    const r = recordOf(b, true);
    expect(csvLine(r)).toBe(`${iso(T)},11,2`);
    const line = recordLine(r, 10);
    expect(JSON.parse(line)).toMatchObject({ t: iso(T), bv: 11, sv: 2, delta: 9, largeBuyVolume: 11, complete: true });
    expect(JSON.parse(line)).not.toHaveProperty("source");
    const back = parseRecordLine(line)!;
    expect(back).toMatchObject({ t: T, bv: 11, sv: 2, sizes: r.sizes, vap: r.vap, source: "recorded", complete: true });
    expect(parseRecordLine("{bad")).toBeNull();
    expect(parseRecordLine("[]")).toBeNull();
    expect(parseRecordLine(JSON.stringify({ t: iso(T), bv: 1, sv: 1, complete: false }))).toBeNull();
    expect(parseRecordLine(JSON.stringify({ t: iso(T), bv: 1, sv: 2, complete: true, sizes: [[1, 2]], vap: "x" }))).toMatchObject({ volume: 3, trades: 0, sizes: [], vap: [] });
  });
});

describe("completeness", () => {
  const end = T + MINUTE_MS + FINALIZE_GRACE_MS;
  // By default a trade message arrived right at end + grace, so the minute settles there.
  const cov = (
    intervals: Array<{ from: number; to: number | null }>,
    o: { lastMsg?: number | null; lastTrade?: number | null; silences?: Array<{ from: number; to: number }>; graceMs?: number; settleMs?: number; skewMs?: number } = {},
  ) => ({
    intervals,
    lastMsg: o.lastMsg === undefined ? end : o.lastMsg,
    lastTrade: o.lastTrade === undefined ? end : o.lastTrade,
    silences: o.silences ?? [],
    graceMs: o.graceMs ?? FINALIZE_GRACE_MS,
    settleMs: o.settleMs ?? RECORDER_GRACE_MS,
    skewMs: o.skewMs ?? 0,
  });
  const from = T - FINALIZE_GRACE_MS; // subscribed just early enough

  it("needs the subscription live from before the minute (with margin) through its end, and the minute settled", () => {
    expect(minuteComplete(T, cov([{ from, to: null }]), end)).toBe(true);
    expect(minuteComplete(T, cov([{ from, to: null }]), end - 1)).toBe(false);
    // Subscribed just before the minute, inside the margin: incomplete.
    expect(minuteComplete(T, cov([{ from: from + 1, to: null }]), end)).toBe(false);
    expect(minuteComplete(T, cov([{ from: T + 1, to: null }]), end)).toBe(false);
    // Disconnected during the minute.
    expect(minuteComplete(T, cov([{ from: T - 5_000, to: T + 30_000 }, { from: T + 40_000, to: null }]), end)).toBe(false);
    expect(minuteComplete(T, cov([{ from: T - 5_000, to: T + MINUTE_MS }]), end)).toBe(true);
    expect(minuteComplete(T, cov([]), end)).toBe(false);
  });

  it("compares the interval start in exchange time when the local clock is behind (negative skew is not clamped)", () => {
    // Local clock 3 s behind: subscribed at local T - 1 s is T + 2 s in exchange time.
    expect(minuteComplete(T, cov([{ from: T - 1_000, to: null }], { skewMs: -3_000 }), end)).toBe(false);
    // 3 s before the minute is enough with clocks in step, not when this clock is 3 s behind.
    expect(minuteComplete(T, cov([{ from: T - 3_000, to: null }], { skewMs: 0 }), end)).toBe(true);
    expect(minuteComplete(T, cov([{ from: T - 3_000, to: null }], { skewMs: -3_000 }), end)).toBe(false);
    expect(minuteComplete(T, cov([{ from: T - 5_000, to: null }], { skewMs: -3_000 }), end)).toBe(true);
    // A positive skew does not move the start.
    expect(minuteComplete(T, cov([{ from, to: null }], { skewMs: 3_000 }), end)).toBe(true);
  });

  it("needs a message after the settle point and no long silence touching the minute", () => {
    const up = [{ from, to: null }];
    expect(minuteComplete(T, cov(up, { lastMsg: end - 1, lastTrade: end - 1 }), end + 60_000)).toBe(false);
    expect(minuteComplete(T, cov(up, { lastMsg: null }), end + 60_000)).toBe(false);
    expect(minuteComplete(T, cov(up, { silences: [{ from: T + 40_000, to: T + 40_000 + SILENCE_LIMIT_MS + 1 }] }), end)).toBe(false);
    expect(minuteComplete(T, cov(up, { silences: [{ from: T - 30_000, to: T }, { from: end, to: end + 20_000 }] }), end)).toBe(true);
    expect(minuteComplete(T, cov(up, { graceMs: 5_000, lastTrade: end + 2_000, lastMsg: end + 2_000 }), end + 2_000)).toBe(false);
    expect(minuteComplete(T, cov(up, { graceMs: 5_000, lastTrade: end + 3_000, lastMsg: end + 3_000 }), end + 3_000)).toBe(true);
  });

  it("settles at end + grace only after a trade message; otherwise at end + the settle grace", () => {
    const up = [{ from, to: null }];
    expect(settlePoint(T, cov(up))).toBe(end);
    expect(settlePoint(T, cov(up, { lastTrade: end - 1 }))).toBe(T + MINUTE_MS + RECORDER_GRACE_MS);
    expect(settlePoint(T, cov(up, { lastTrade: null, settleMs: 15_000 }))).toBe(T + MINUTE_MS + 15_000);
    // Quotes alone after the minute don't settle it early.
    const quotesOnly = cov(up, { lastTrade: T + 30_000, lastMsg: end + 5_000 });
    expect(minuteDecided(T, quotesOnly, end + 5_000)).toBe(false);
    expect(minuteComplete(T, quotesOnly, end + 5_000)).toBe(false);
    const later = cov(up, { lastTrade: T + 30_000, lastMsg: T + MINUTE_MS + RECORDER_GRACE_MS });
    expect(minuteDecided(T, later, T + MINUTE_MS + RECORDER_GRACE_MS)).toBe(true);
    expect(minuteComplete(T, later, T + MINUTE_MS + RECORDER_GRACE_MS)).toBe(true);
  });

  it("a minute is decided once settled with a message after, or the silence since exceeds the limit", () => {
    const up = [{ from, to: null }];
    expect(minuteDecided(T, cov(up), end)).toBe(true);
    const p = T + MINUTE_MS + RECORDER_GRACE_MS;
    expect(minuteDecided(T, cov(up, { lastMsg: end - 1, lastTrade: end - 1 }), p)).toBe(false);
    expect(minuteDecided(T, cov(up, { lastMsg: end - 1, lastTrade: end - 1 }), p + SILENCE_LIMIT_MS)).toBe(true);
    expect(minuteDecided(T, cov(up), end - 1)).toBe(false);
  });

  it("cross-checks the prints against the quote feed's volume and last price", () => {
    const b = (o: Partial<ReturnType<typeof newBucket>> = {}) => ({ ...newBucket(T), ...o });
    // Quiet: no print, quote volume known and flat.
    expect(tradeFeedCheck(b({ qvSamples: 3, qvOpen: 500, qvClose: 500 }), true)).toBe("ok");
    expect(tradeFeedCheck(b(), true)).toBe("ok"); // no quote in the minute, volume carried from before
    // No print but the volume rose, or the last price moved: the trade feed missed trades.
    expect(tradeFeedCheck(b({ qvSamples: 2, qvOpen: 500, qvClose: 501 }), true)).toBe("mismatch");
    expect(tradeFeedCheck(b({ qvSamples: 2, qvOpen: 500, qvClose: 500, lastPriceChanged: true }), true)).toBe("mismatch");
    // Unknown volume: a zero-print minute can't be confirmed.
    expect(tradeFeedCheck(b(), false)).toBe("unknown");
    expect(tradeFeedCheck(b({ qvSamples: 1, qvOpen: null, qvClose: 500 }), false)).toBe("unknown");
    expect(tradeFeedCheck(b({ qvSamples: 1, qvOpen: 600, qvClose: 5 }), true)).toBe("unknown"); // went down (reset)
    // Prints: the volume may exceed them by max(2, 2 %) at most.
    expect(tradeFeedCheck(b({ trades: 2, volume: 10, qvSamples: 2, qvOpen: 500, qvClose: 512 }), true)).toBe("ok");
    expect(tradeFeedCheck(b({ trades: 2, volume: 10, qvSamples: 2, qvOpen: 500, qvClose: 513 }), true)).toBe("mismatch");
    expect(tradeFeedCheck(b({ trades: 9, volume: 1000, qvSamples: 2, qvOpen: 0, qvClose: 1020 }), true)).toBe("ok");
    expect(tradeFeedCheck(b({ trades: 9, volume: 1000, qvSamples: 2, qvOpen: 0, qvClose: 1021 }), true)).toBe("mismatch");
    expect(tradeFeedCheck(b({ trades: 1, volume: 1, lastPriceChanged: true }), false)).toBe("ok");
  });

  it("median", () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("reports incomplete or missing runs as gaps", () => {
    const m = new Map([T, T + MINUTE_MS, T + 2 * MINUTE_MS, T + 4 * MINUTE_MS].map((t, i) => [t, rec(t, { complete: i !== 1 })]));
    expect(gapsOf(m, T, T + 4 * MINUTE_MS)).toEqual([
      { from: iso(T + MINUTE_MS), to: iso(T + 2 * MINUTE_MS), minutes: 1 },
      { from: iso(T + 3 * MINUTE_MS), to: iso(T + 4 * MINUTE_MS), minutes: 1 },
    ]);
    expect(gapsOf(new Map(), T, T + MINUTE_MS)).toEqual([{ from: iso(T), to: iso(T + 2 * MINUTE_MS), minutes: 2 }]);
  });
});

describe("cumulative delta", () => {
  // 17:00 America/Chicago (CDT) on 2026-10-12 is 22:00 UTC.
  const S = Date.UTC(2026, 9, 12, 22, 0);

  it("resets at the 17:00 CT session start and is null after an unknown minute", () => {
    const m = new Map<number, MinuteRecord>();
    m.set(S - 2 * MINUTE_MS, rec(S - 2 * MINUTE_MS, { bv: 5 }));
    m.set(S - MINUTE_MS, rec(S - MINUTE_MS, { bv: 5 }));
    m.set(S, rec(S, { bv: 4, sv: 1 }));
    m.set(S + MINUTE_MS, rec(S + MINUTE_MS, { bv: 1, sv: 3 }));
    m.set(S + 2 * MINUTE_MS, rec(S + 2 * MINUTE_MS, { bv: 9, complete: false }));
    m.set(S + 3 * MINUTE_MS, rec(S + 3 * MINUTE_MS, { bv: 1 }));
    const c = cumulativeDeltas(m, S - 2 * MINUTE_MS, S + 3 * MINUTE_MS);
    // The earlier session's start is not covered: unknown.
    expect(c.get(S - MINUTE_MS)).toBeNull();
    expect(c.get(S)).toBe(3);
    expect(c.get(S + MINUTE_MS)).toBe(1);
    expect(c.get(S + 2 * MINUTE_MS)).toBeNull();
    expect(c.get(S + 3 * MINUTE_MS)).toBeNull();
    // A missing minute is unknown too.
    m.delete(S + MINUTE_MS);
    expect(cumulativeDeltas(m, S, S + MINUTE_MS).get(S + MINUTE_MS)).toBeNull();
  });
});

describe("footprint", () => {
  it("merges volume at price over the bar's minutes, finds the POC, delta and imbalances", () => {
    const m1 = rec(T, { vap: [[100, 2, 0], [100.25, 1, 4], [99.75, 6, 0]] });
    const m2 = rec(T + MINUTE_MS, { vap: [[100, 0, 1], [100.25, 0, 5], [100.5, 0, 4]], source: "recorded" });
    const bar = footprintBar(T, 2, [m1, m2], 0.25, 3);
    expect(bar).toMatchObject({ t: iso(T), complete: true, minutes: 2, volume: 23, delta: 5, poc: 100.25 });
    expect(bar.sources.sort()).toEqual(["live", "recorded"]);
    expect(bar.levels).toEqual([
      { price: 100.5, bidVolume: 0, askVolume: 4, buyImbalance: true, sellImbalance: false },
      { price: 100.25, bidVolume: 1, askVolume: 9, buyImbalance: true, sellImbalance: false },
      { price: 100, bidVolume: 2, askVolume: 1, buyImbalance: false, sellImbalance: false },
      { price: 99.75, bidVolume: 6, askVolume: 0, buyImbalance: false, sellImbalance: true },
    ]);
    // A higher ratio turns flags off: 9 < 5 x 2.
    expect(footprintBar(T, 2, [m1, m2], 0.25, 5).levels[1].buyImbalance).toBe(false);
    // Without a tick size the flags are unknown.
    expect(footprintBar(T, 2, [m1, m2], null, 3).levels[0].buyImbalance).toBeNull();
  });

  it("breaks a POC tie toward the bar's VWAP, then toward the lower price", () => {
    // 100 and 100.5 tie at 5; 101 adds weight above, so the VWAP (100.5625) is nearest 100.5.
    expect(footprintBar(T, 1, [rec(T, { vap: [[100, 5, 0], [100.5, 0, 5], [101, 1, 2]] })], 0.25, 3).poc).toBe(100.5);
    // Weight below: the VWAP (99.96) is nearest 100, the later (lower) of the tied prices.
    expect(footprintBar(T, 1, [rec(T, { vap: [[100, 5, 0], [100.5, 0, 5], [99, 1, 2]] })], 0.25, 3).poc).toBe(100);
    // Equal distance from the VWAP (100.25): the lower price.
    expect(footprintBar(T, 1, [rec(T, { vap: [[100, 5, 0], [100.5, 0, 5]] })], 0.25, 3).poc).toBe(100);
    expect(footprintBar(T, 1, [rec(T, { vap: [[100.5, 0, 5], [100, 5, 0]] })], 0.25, 3).poc).toBe(100);
  });

  it("is complete only when every minute is present and complete", () => {
    expect(footprintBar(T, 2, [rec(T), rec(T + MINUTE_MS, { complete: false })], 0.25, 3).complete).toBe(false);
    expect(footprintBar(T, 2, [rec(T), undefined], 0.25, 3).complete).toBe(false);
    expect(footprintBar(T, 2, [rec(T)], 0.25, 3).complete).toBe(false);
    expect(footprintBar(T, 1, [rec(T)], 0.25, 3)).toMatchObject({ complete: true, poc: null, volume: 0 });
  });
});

describe("mergeRecords", () => {
  it("prefers a complete recorded minute over an incomplete live one, and keeps complete live minutes", () => {
    const live = [rec(T, { complete: false, bv: 1 }), rec(T + MINUTE_MS, { bv: 2 })];
    const recorded = [rec(T, { bv: 5, source: "recorded" }), rec(T + MINUTE_MS, { bv: 9, source: "recorded" }), rec(T - MINUTE_MS, { bv: 7, source: "recorded" })];
    const m = mergeRecords(live, recorded);
    expect(m.get(T)).toMatchObject({ bv: 5, source: "recorded" });
    expect(m.get(T + MINUTE_MS)).toMatchObject({ bv: 2, source: "live" });
    expect(m.get(T - MINUTE_MS)).toMatchObject({ bv: 7, source: "recorded" });
  });
});
