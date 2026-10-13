/**
 * Order flow from the ProjectX market hub: pure parsing, the L2 book, per-minute
 * aggregation, quote OFI, footprints and cumulative delta. No I/O, no clock:
 * every time is passed in, so all of it is unit-tested with plain values.
 */
import { tradingDayStart } from "./risk.js";
import { snapToTick } from "./ticks.js";

export const MINUTE_MS = 60_000;

/**
 * GatewayTrade `type` → aggressor side, per the ProjectX TradeLogType docs:
 * 0 = Buy (the aggressor lifted the ask), 1 = Sell (the aggressor hit the bid).
 * UNVERIFIED against the live hub. Any other type has no side: it counts in
 * volume, trades and VWAP but not in buy/sell volume or the footprint.
 */
export const TRADE_SIDE_BY_TYPE: Readonly<Record<number, Side>> = Object.freeze({ 0: "buy", 1: "sell" });

/** GatewayDepth `type` (ProjectX DomType). UNVERIFIED against the live hub. */
export const DOM_TYPE = Object.freeze({
  Unknown: 0,
  Ask: 1,
  Bid: 2,
  BestAsk: 3,
  BestBid: 4,
  Trade: 5,
  Reset: 6,
  Low: 7,
  High: 8,
  NewBestBid: 9,
  NewBestAsk: 10,
  Fill: 11,
});

const ASK_TYPES: ReadonlySet<number> = new Set([DOM_TYPE.Ask, DOM_TYPE.BestAsk, DOM_TYPE.NewBestAsk]);
const BID_TYPES: ReadonlySet<number> = new Set([DOM_TYPE.Bid, DOM_TYPE.BestBid, DOM_TYPE.NewBestBid]);
const BEST_TYPES: ReadonlySet<number> = new Set([DOM_TYPE.BestAsk, DOM_TYPE.NewBestAsk, DOM_TYPE.BestBid, DOM_TYPE.NewBestBid]);

export type Side = "buy" | "sell";

export interface Print {
  /** Exchange time (ms); the receive time when the timestamp was unusable. */
  t: number;
  price: number;
  size: number;
  /** Aggressor side; null for a trade type with no known side. */
  side: Side | null;
  /** The exchange timestamp was unusable and `t` is the receive time. */
  badTimestamp?: boolean;
}

export interface DepthEntry {
  t: number;
  type: number;
  price: number;
  volume: number;
  badTimestamp?: boolean;
}

/** A timestamp more than this far from the receive time is treated as unusable. */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** An ISO time must say its offset (`Z` or `+hh:mm`); a local time without one is ambiguous. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * A hub timestamp in ms: an ISO string with an explicit offset, or epoch ms.
 * Anything else, or a time more than MAX_CLOCK_SKEW_MS from the receive time,
 * is bad: the receive time is used instead and the caller counts it.
 */
export function parseTimestamp(value: unknown, receivedAt: number): { t: number; bad: boolean } {
  const t = typeof value === "number" ? value : typeof value === "string" && HAS_OFFSET.test(value.trim()) ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || Math.abs(t - receivedAt) > MAX_CLOCK_SKEW_MS) return { t: receivedAt, bad: true };
  return { t, bad: false };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asList = (payload: unknown): unknown[] => (Array.isArray(payload) ? payload : [payload]);

export interface Parsed<T> {
  items: T[];
  /** Items that were not usable (wrong shape, non-numeric price or size). */
  skipped: number;
  badTimestamps: number;
}

/** GatewayTrade payload (an array or one item of {symbolId, price, timestamp, type, volume}). Never throws. */
export function parseTrades(payload: unknown, receivedAt: number): Parsed<Print> {
  const out: Parsed<Print> = { items: [], skipped: 0, badTimestamps: 0 };
  for (const raw of asList(payload)) {
    if (!isObj(raw) || !finite(raw.price) || !finite(raw.volume) || raw.volume <= 0 || raw.price <= 0) {
      out.skipped++;
      continue;
    }
    const ts = parseTimestamp(raw.timestamp, receivedAt);
    if (ts.bad) out.badTimestamps++;
    const side = typeof raw.type === "number" ? (TRADE_SIDE_BY_TYPE[raw.type] ?? null) : null;
    out.items.push({ t: ts.t, price: raw.price, size: raw.volume, side, ...(ts.bad ? { badTimestamp: true } : {}) });
  }
  return out;
}

/** GatewayDepth payload (an array or one item of {timestamp, type, price, volume, currentVolume}). Never throws. */
export function parseDepth(payload: unknown, receivedAt: number): Parsed<DepthEntry> {
  const out: Parsed<DepthEntry> = { items: [], skipped: 0, badTimestamps: 0 };
  for (const raw of asList(payload)) {
    if (!isObj(raw) || !finite(raw.type)) {
      out.skipped++;
      continue;
    }
    const reset = raw.type === DOM_TYPE.Reset;
    if (!reset && (!finite(raw.price) || !finite(raw.volume) || raw.volume < 0)) {
      out.skipped++;
      continue;
    }
    const ts = parseTimestamp(raw.timestamp, receivedAt);
    if (ts.bad) out.badTimestamps++;
    if (reset) {
      out.items.push({ t: ts.t, type: raw.type, price: 0, volume: 0, ...(ts.bad ? { badTimestamp: true } : {}) });
      continue;
    }
    out.items.push({ t: ts.t, type: raw.type, price: raw.price as number, volume: raw.volume as number, ...(ts.bad ? { badTimestamp: true } : {}) });
  }
  return out;
}

/** Fixed-capacity ring buffer: pushing past the cap drops the oldest item. */
export class Ring<T> {
  private readonly buf: T[] = [];
  private start = 0;

  constructor(readonly cap: number) {}

  get length(): number {
    return this.buf.length;
  }

  push(item: T): void {
    if (this.buf.length < this.cap) this.buf.push(item);
    else {
      this.buf[this.start] = item;
      this.start = (this.start + 1) % this.cap;
    }
  }

  /** Oldest → newest. */
  toArray(): T[] {
    return [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)];
  }

  /** The newest `n` items, oldest → newest. */
  last(n: number): T[] {
    if (n <= 0) return [];
    const all = this.toArray();
    return all.slice(Math.max(0, all.length - n));
  }

  latest(): T | undefined {
    if (!this.buf.length) return undefined;
    return this.buf[(this.start + this.buf.length - 1) % this.buf.length];
  }

  clear(): void {
    this.buf.length = 0;
    this.start = 0;
  }
}

export interface Level {
  price: number;
  size: number;
}

export interface LevelChange {
  t: number;
  side: "bid" | "ask" | null;
  price: number | null;
  size: number;
  prevSize: number;
  type: number;
}

/** Most price levels kept per side; the farthest from the best is dropped beyond it. */
export const MAX_BOOK_LEVELS = 1000;

/**
 * Per-contract L2 book: price → size per side, from GatewayDepth. Reset clears
 * it; a level with size 0 is removed; Trade, Fill, Low, High and Unknown don't
 * touch it. A BestBid/NewBestBid at P removes bids above P (and BestAsk /
 * NewBestAsk at P removes asks below P), since those levels are no longer there.
 * Sizes come from `volume` (UNVERIFIED: `currentVolume` is not used).
 *
 * The book is `valid` only once a level with size on each side arrived since
 * the last reset or reconnect; with one side only it is `partial`.
 */
export class Book {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  private seenBid = false;
  private seenAsk = false;
  private afterReset = false;
  /** True once the book became valid right after a Reset (a Reset-led snapshot). */
  snapshot = false;
  /** Receive time of the last depth entry applied (any type). */
  lastUpdate: number | null = null;

  /** Both sides seen since the last reset or reconnect. */
  get valid(): boolean {
    return this.seenBid && this.seenAsk;
  }

  /** Levels arrived since the last reset, but only on one side. */
  get partial(): boolean {
    return !this.valid && (this.seenBid || this.seenAsk);
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.seenBid = this.seenAsk = false;
    this.afterReset = false;
    this.snapshot = false;
  }

  apply(e: DepthEntry, at: number): LevelChange[] {
    this.lastUpdate = at;
    if (e.type === DOM_TYPE.Reset) {
      this.clear();
      this.afterReset = true;
      return [{ t: at, side: null, price: null, size: 0, prevSize: 0, type: e.type }];
    }
    const isAsk = ASK_TYPES.has(e.type);
    if (!isAsk && !BID_TYPES.has(e.type)) return [];
    const side = isAsk ? this.asks : this.bids;
    const name = isAsk ? "ask" : "bid";
    const changes: LevelChange[] = [];
    const set = (price: number, size: number, type: number) => {
      const prev = side.get(price) ?? 0;
      if (size === 0) side.delete(price);
      else side.set(price, size);
      if (prev !== size) changes.push({ t: at, side: name, price, size, prevSize: prev, type });
    };
    if (BEST_TYPES.has(e.type) && e.volume > 0) {
      for (const p of [...side.keys()]) if (isAsk ? p < e.price : p > e.price) set(p, 0, e.type);
    }
    set(e.price, e.volume, e.type);
    if (e.volume > 0) {
      const wasValid = this.valid;
      if (isAsk) this.seenAsk = true;
      else this.seenBid = true;
      if (!wasValid && this.valid && this.afterReset) this.snapshot = true;
    }
    if (side.size > MAX_BOOK_LEVELS) {
      const far = [...side.keys()].sort((a, b) => (isAsk ? b - a : a - b));
      for (const p of far.slice(0, side.size - MAX_BOOK_LEVELS)) side.delete(p);
    }
    return changes;
  }

  /** Top `n` levels of a side, best first (bids high→low, asks low→high). */
  levels(which: "bid" | "ask", n = Infinity): Level[] {
    const side = which === "bid" ? this.bids : this.asks;
    return [...side.entries()]
      .sort((a, b) => (which === "bid" ? b[0] - a[0] : a[0] - b[0]))
      .slice(0, n)
      .map(([price, size]) => ({ price, size }));
  }

  best(which: "bid" | "ask"): Level | null {
    const side = which === "bid" ? this.bids : this.asks;
    let best: Level | null = null;
    for (const [price, size] of side) {
      if (!best || (which === "bid" ? price > best.price : price < best.price)) best = { price, size };
    }
    return best;
  }

  /** (bidSize - askSize) / (bidSize + askSize) over the top n levels; null without a valid book or size. */
  imbalance(n: number): number | null {
    if (!this.valid) return null;
    const b = this.levels("bid", n).reduce((s, l) => s + l.size, 0);
    const a = this.levels("ask", n).reduce((s, l) => s + l.size, 0);
    return b + a > 0 ? (b - a) / (b + a) : null;
  }
}

/** One L1 (top of book) state; sizes are null when only the quote feed had it. */
export interface L1Event {
  t: number;
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
  source: "depth" | "quote";
}

/**
 * One event's order-flow imbalance (Cont, Kukanov & Stoikov 2014, "The Price
 * Impact of Order Book Events", eq. 2):
 *   e_n = 1{Pb_n >= Pb_n-1} qb_n - 1{Pb_n <= Pb_n-1} qb_n-1
 *       - 1{Pa_n <= Pa_n-1} qa_n + 1{Pa_n >= Pa_n-1} qa_n-1
 * Null when either state lacks a price or a size.
 */
export function ofiEvent(prev: L1Event, cur: L1Event): number | null {
  const v = [prev.bid, prev.bidSize, prev.ask, prev.askSize, cur.bid, cur.bidSize, cur.ask, cur.askSize];
  if (v.some((x) => x === null)) return null;
  const [pb, qb0, pa, qa0, b, qb, a, qa] = v as number[];
  return (b >= pb ? qb : 0) - (b <= pb ? qb0 : 0) - (a <= pa ? qa : 0) + (a >= pa ? qa0 : 0);
}

/** OFI summed over consecutive events (the per-minute quote OFI). */
export function quoteOfi(events: L1Event[]): number {
  let sum = 0;
  for (let i = 1; i < events.length; i++) sum += ofiEvent(events[i - 1], events[i]) ?? 0;
  return sum;
}

/** Mutable per-minute accumulator. */
export interface MinuteBucket {
  t: number;
  bv: number;
  sv: number;
  volume: number;
  trades: number;
  pv: number;
  high: number | null;
  low: number | null;
  maxPrint: number | null;
  /** print size → [buy volume, sell volume], so any large-print threshold can be applied later. */
  sizes: Map<number, [number, number]>;
  /** price → [bid-side volume (sell aggressor), ask-side volume (buy aggressor)]. */
  vap: Map<number, [number, number]>;
  ofiQuote: number;
  ofiEvents: number;
  /** ∫ book imbalance dt and the ms the book was valid during the minute. */
  imbArea: number;
  imbMs: number;
  /** Prints or depth entries in this minute whose exchange timestamp was unusable. */
  badTimestamps: number;
  /** Volume of prints with no known aggressor side. */
  sidelessVolume: number;
  /** GatewayQuote session volume: samples received in this minute, the value before the first one, and the last one. */
  qvSamples: number;
  qvOpen: number | null;
  qvClose: number | null;
  /** Last quote volume received within the lag window after the minute's start (null: none, so it equals qvOpen). */
  qvWin: number | null;
  /** The quote's lastPrice changed during the minute (in a way the prints don't explain). */
  lastPriceChanged: boolean;
  /** Exchange time and price of the minute's latest print. */
  lastPrintT: number | null;
  lastPrintPrice: number | null;
}

export const minuteOf = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;

export function newBucket(t: number): MinuteBucket {
  return { t: minuteOf(t), bv: 0, sv: 0, volume: 0, trades: 0, pv: 0, high: null, low: null, maxPrint: null, sizes: new Map(), vap: new Map(), ofiQuote: 0, ofiEvents: 0, imbArea: 0, imbMs: 0, badTimestamps: 0, sidelessVolume: 0, qvSamples: 0, qvOpen: null, qvClose: null, qvWin: null, lastPriceChanged: false, lastPrintT: null, lastPrintPrice: null };
}

const key = (price: number) => Number(price.toFixed(10));

export function addPrint(b: MinuteBucket, p: Print): void {
  b.volume += p.size;
  b.trades += 1;
  b.pv += p.price * p.size;
  b.high = b.high === null ? p.price : Math.max(b.high, p.price);
  b.low = b.low === null ? p.price : Math.min(b.low, p.price);
  b.maxPrint = b.maxPrint === null ? p.size : Math.max(b.maxPrint, p.size);
  if (b.lastPrintT === null || p.t >= b.lastPrintT) {
    b.lastPrintT = p.t;
    b.lastPrintPrice = p.price;
  }
  if (p.badTimestamp) b.badTimestamps += 1;
  if (!p.side) {
    b.sidelessVolume += p.size;
    return;
  }
  if (p.side === "buy") b.bv += p.size;
  else b.sv += p.size;
  const s = b.sizes.get(p.size) ?? [0, 0];
  s[p.side === "buy" ? 0 : 1] += p.size;
  b.sizes.set(p.size, s);
  const k = key(p.price);
  const v = b.vap.get(k) ?? [0, 0];
  v[p.side === "buy" ? 1 : 0] += p.size;
  b.vap.set(k, v);
}

/** A finished (or in-progress) minute in plain, serializable form: what live and recorded data share. */
export interface MinuteRecord {
  t: number;
  bv: number;
  sv: number;
  volume: number;
  trades: number;
  vwap: number | null;
  high: number | null;
  low: number | null;
  maxPrint: number | null;
  /** [size, buy volume, sell volume] */
  sizes: Array<[number, number, number]>;
  /** [price, bid-side volume, ask-side volume] */
  vap: Array<[number, number, number]>;
  ofiQuote: number | null;
  bookImbalance: number | null;
  badTimestamps: number;
  sidelessVolume: number;
  complete: boolean;
  source: "live" | "recorded";
}

/**
 * The record of a minute. `covered` is the feed's verdict (minuteComplete); the
 * minute is complete only if, in addition, no timestamp in it was unusable and
 * every print had a known side.
 */
export function recordOf(b: MinuteBucket, covered: boolean): MinuteRecord {
  return {
    t: b.t,
    bv: b.bv,
    sv: b.sv,
    volume: b.volume,
    trades: b.trades,
    vwap: b.volume > 0 ? Number((b.pv / b.volume).toFixed(10)) : null,
    high: b.high,
    low: b.low,
    maxPrint: b.maxPrint,
    sizes: [...b.sizes].map(([s, [buy, sell]]) => [s, buy, sell]),
    vap: [...b.vap].map(([p, [bid, ask]]) => [p, bid, ask]),
    // No book seen during the minute: OFI and imbalance are unknown, not zero.
    ofiQuote: b.imbMs > 0 || b.ofiEvents > 0 ? b.ofiQuote : null,
    bookImbalance: b.imbMs > 0 ? b.imbArea / b.imbMs : null,
    badTimestamps: b.badTimestamps,
    sidelessVolume: b.sidelessVolume,
    complete: covered && b.badTimestamps === 0 && b.sidelessVolume === 0,
    source: "live",
  };
}

const num = (v: unknown): number | null => (finite(v) ? v : null);
const triples = (v: unknown): Array<[number, number, number]> =>
  Array.isArray(v) ? (v.filter((x) => Array.isArray(x) && x.length === 3 && x.every(finite)) as Array<[number, number, number]>) : [];

/** A recorded JSONL line back into a record; null when it is not one. */
export function parseRecordLine(line: string): MinuteRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const t = typeof o.t === "string" ? Date.parse(o.t) : NaN;
  if (!Number.isFinite(t) || !finite(o.bv) || !finite(o.sv) || o.complete !== true) return null;
  return {
    t,
    bv: o.bv,
    sv: o.sv,
    volume: num(o.volume) ?? o.bv + o.sv,
    trades: num(o.trades) ?? 0,
    vwap: num(o.vwap),
    high: num(o.high),
    low: num(o.low),
    maxPrint: num(o.maxPrint),
    sizes: triples(o.sizes),
    vap: triples(o.vap),
    ofiQuote: num(o.ofiQuote),
    bookImbalance: num(o.bookImbalance),
    badTimestamps: num(o.badTimestamps) ?? 0,
    sidelessVolume: num(o.sidelessVolume) ?? 0,
    complete: true,
    source: "recorded",
  };
}

export interface MinuteRow {
  t: string;
  bv: number;
  sv: number;
  delta: number;
  volume: number;
  trades: number;
  vwap: number | null;
  high: number | null;
  low: number | null;
  maxPrint: number | null;
  largeBuyVolume: number;
  largeSellVolume: number;
  ofiTrades: number | null;
  ofiQuote: number | null;
  bookImbalance: number | null;
  badTimestamps: number;
  sidelessVolume: number;
  complete: boolean;
  /** Session cumulative delta through this minute; null when any minute since the session start is unknown. */
  cumDelta: number | null;
  source: "live" | "recorded";
}

/** The row a tool returns for a record, with large prints at `largePrint` contracts or more. */
export function rowOf(r: MinuteRecord, largePrint: number, cumDelta: number | null): MinuteRow {
  let largeBuyVolume = 0;
  let largeSellVolume = 0;
  for (const [size, buy, sell] of r.sizes) {
    if (size >= largePrint) {
      largeBuyVolume += buy;
      largeSellVolume += sell;
    }
  }
  return {
    t: new Date(r.t).toISOString(),
    bv: r.bv,
    sv: r.sv,
    delta: r.bv - r.sv,
    volume: r.volume,
    trades: r.trades,
    vwap: r.vwap,
    high: r.high,
    low: r.low,
    maxPrint: r.maxPrint,
    largeBuyVolume,
    largeSellVolume,
    ofiTrades: r.bv + r.sv > 0 ? (r.bv - r.sv) / (r.bv + r.sv) : null,
    ofiQuote: r.ofiQuote,
    bookImbalance: r.bookImbalance,
    badTimestamps: r.badTimestamps,
    sidelessVolume: r.sidelessVolume,
    complete: r.complete,
    cumDelta,
    source: r.source,
  };
}

/** The JSONL line the recorder writes for a complete minute. */
export function recordLine(r: MinuteRecord, largePrint: number): string {
  const { cumDelta: _c, source: _s, ...row } = rowOf(r, largePrint, null);
  return JSON.stringify({ ...row, sizes: r.sizes, vap: r.vap });
}

/** The CSV line a consumer reads: `ISO-time,buy_volume,sell_volume`. */
export const csvLine = (r: MinuteRecord) => `${new Date(r.t).toISOString()},${r.bv},${r.sv}`;

/** A live trade-subscription interval; `to` is null while it is still up. */
export interface LiveInterval {
  from: number;
  to: number | null;
}

/** Short grace: a minute can settle this long after its end once a trade message arrived after that point (plus the measured delay). */
export const FINALIZE_GRACE_MS = 2_000;
/** Settle grace without a later trade message: a minute settles only this long after its end (plus the positive median delay, capped). */
export const RECORDER_GRACE_MS = 10_000;
export const MAX_RECORDER_GRACE_MS = 20_000;
/** Longest lag window after a boundary in which a quote may still catch up with the previous minute's prints. */
export const MAX_LAG_WINDOW_MS = 5_000;

/** The lag window: max(1 s, median delay), capped at the smaller of MAX_SKEW_GRACE_MS and MAX_LAG_WINDOW_MS. */
export function lagWindowMs(medianDelayMs: number): number {
  return Math.min(MAX_SKEW_GRACE_MS, MAX_LAG_WINDOW_MS, Math.max(1_000, medianDelayMs));
}

/** Below this median (receive - exchange) the local clock is behind the exchange; warned once. */
export const CLOCK_BEHIND_WARN_MS = -500;
/** Most the measured exchange-to-receive delay adds to the grace. */
export const MAX_SKEW_GRACE_MS = 10_000;
/**
 * Longest silence between two hub messages for a contract (quotes, depth or
 * trades) that still counts as connected. MNQ and MES quotes and depth update
 * many times a second while the market is open, so a longer silence means a
 * dead socket, a stalled process, or a closed market: the minutes it touches
 * are not complete.
 */
export const SILENCE_LIMIT_MS = 10_000;

/** What the feed knows about a contract's coverage. */
export interface FeedCoverage {
  intervals: readonly LiveInterval[];
  /** Receive time of the last hub message for the contract (any kind). */
  lastMsg: number | null;
  /** Gaps between consecutive messages longer than SILENCE_LIMIT_MS. */
  silences: ReadonlyArray<{ from: number; to: number }>;
  /** FINALIZE_GRACE_MS plus the measured skew (capped). */
  graceMs: number;
  /** Receive time of the last trade message for the contract. */
  lastTrade: number | null;
  /** RECORDER_GRACE_MS plus the positive median delay, capped at MAX_RECORDER_GRACE_MS. */
  settleMs: number;
  /** Median (receive - exchange) of recent prints, not clamped: negative when the local clock is behind. */
  skewMs: number;
}

/**
 * When a minute settles: end + graceMs once a trade message arrived after that
 * point (trades arrive in order, so the minute's prints are in), else end + settleMs.
 */
export function settlePoint(t: number, cov: FeedCoverage): number {
  const end = t + MINUTE_MS;
  return cov.lastTrade !== null && cov.lastTrade >= end + cov.graceMs ? end + cov.graceMs : end + cov.settleMs;
}

/**
 * A minute [t, t+60 s) is covered only when, with P its settle point:
 * - the trade subscription was confirmed before it started, in exchange time
 *   (the start corrected by a negative median skew, plus FINALIZE_GRACE_MS), and stayed connected through its end,
 * - a hub message for the contract arrived at or after P (the feed was alive after it), and
 * - no gap between consecutive messages longer than SILENCE_LIMIT_MS touches [t, P].
 */
export function minuteComplete(t: number, cov: FeedCoverage, now: number): boolean {
  const end = t + MINUTE_MS;
  const p = settlePoint(t, cov);
  if (now < p || cov.lastMsg === null || cov.lastMsg < p) return false;
  if (cov.silences.some((s) => s.from < p && s.to > t)) return false;
  const behind = Math.min(0, cov.skewMs);
  return cov.intervals.some((iv) => iv.from - behind + FINALIZE_GRACE_MS <= t && (iv.to === null || iv.to >= end));
}

/** Whether a minute's completeness can no longer change: it settled and a message after that arrived, or the silence since exceeds the limit. */
export function minuteDecided(t: number, cov: FeedCoverage, now: number): boolean {
  const p = settlePoint(t, cov);
  return now >= p && ((cov.lastMsg !== null && cov.lastMsg >= p) || now >= p + SILENCE_LIMIT_MS);
}

export type TradeFeedCheck = "ok" | "unknown" | "mismatch";

/**
 * The quote's session-volume change over a minute (quotes bucketed by receive
 * time): null when unknown, or when it went down (e.g. a session reset).
 * `carried`: a quote volume was known before the minute (for a minute with no quote sample).
 */
export function quoteVolumeDelta(b: MinuteBucket, carried: boolean): number | null {
  let delta: number | null;
  if (b.qvSamples > 0) delta = b.qvOpen === null || b.qvClose === null ? null : b.qvClose - b.qvOpen;
  else delta = carried ? 0 : null;
  return delta !== null && delta < 0 ? null : delta;
}

/**
 * Prints a minute had beyond its quote-volume change: volume whose quote
 * update arrived after the boundary (prints go by exchange time, quotes by
 * receive time). It is allowed into the next minute, so a forward shift nets to zero.
 */
export function quoteShortfall(b: MinuteBucket, carried: boolean): number {
  const delta = quoteVolumeDelta(b, carried);
  return delta === null ? 0 : Math.max(0, b.volume - delta);
}

/**
 * Cross-check a minute's prints against the quote feed, so a dead trade
 * subscription with live quotes never passes as quiet minutes. `carryIn` is the
 * previous minute's shortfall (only across one continuous live interval); it can
 * explain only quote volume received within the lag window after the boundary:
 * - mismatch: the quote's session volume rose by more than the prints plus
 *   min(carryIn, the rise within the window) plus max(2 contracts, 2 %); or, with no print,
 *   the rise within the window exceeds carryIn, the volume rose after the window,
 *   or the lastPrice changed in a way the prints don't explain;
 * - unknown: no print and the quote volume is not known at both ends (or went down);
 * - ok otherwise.
 */
export function tradeFeedCheck(b: MinuteBucket, carried: boolean, carryIn = 0): TradeFeedCheck {
  if (b.trades === 0 && b.lastPriceChanged) return "mismatch";
  const delta = quoteVolumeDelta(b, carried);
  if (delta === null) return b.trades === 0 ? "unknown" : "ok";
  const atWin = b.qvSamples > 0 ? (b.qvWin ?? b.qvOpen) : null;
  const early = atWin === null || b.qvOpen === null ? 0 : Math.max(0, atWin - b.qvOpen);
  const allowed = Math.min(carryIn, early);
  if (b.trades === 0) return delta === 0 || (early <= carryIn && delta - early === 0) ? "ok" : "mismatch";
  return delta > b.volume + allowed + Math.max(2, 0.02 * b.volume) ? "mismatch" : "ok";
}

/** Median of the values (0 for none). */
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Session cumulative delta per minute for records keyed by minute start. The
 * session resets at the trading-day start (17:00 America/Chicago). The value is
 * null from the first missing or incomplete minute of a session onwards, since
 * an unknown gap makes the running sum unknown.
 */
export function cumulativeDeltas(byMinute: ReadonlyMap<number, MinuteRecord>, from: number, to: number): Map<number, number | null> {
  const out = new Map<number, number | null>();
  let session = NaN;
  let sum: number | null = null;
  let s = NaN;
  let nextHour = -Infinity;
  for (let t = minuteOf(from); t <= to; t += MINUTE_MS) {
    // The session starts on a whole UTC hour (17:00 CT), so it can only change at an hour boundary.
    if (t >= nextHour) {
      s = tradingDayStart(new Date(t)).getTime();
      nextHour = Math.floor(t / 3600_000) * 3600_000 + 3600_000;
    }
    if (s !== session) {
      session = s;
      // The running sum is known only when it starts at the session's first minute.
      sum = t === s ? 0 : null;
    }
    const r = byMinute.get(t);
    sum = sum !== null && r?.complete ? sum + r.bv - r.sv : null;
    out.set(t, sum);
  }
  return out;
}

export interface FootprintLevel {
  price: number;
  /** Sell-aggressor volume (traded at the bid). */
  bidVolume: number;
  /** Buy-aggressor volume (traded at the ask). */
  askVolume: number;
  /** askVolume(P) >= ratio x bidVolume(P - 1 tick), with a non-zero denominator; null without a tick size. */
  buyImbalance: boolean | null;
  /** bidVolume(P) >= ratio x askVolume(P + 1 tick), with a non-zero denominator; null without a tick size. */
  sellImbalance: boolean | null;
}

export interface FootprintBar {
  t: string;
  complete: boolean;
  minutes: number;
  volume: number;
  delta: number;
  poc: number | null;
  levels: FootprintLevel[];
  sources: Array<"live" | "recorded">;
}

/** One footprint bar from its minutes' records (a missing minute makes it incomplete). */
export function footprintBar(start: number, barMinutes: number, records: Array<MinuteRecord | undefined>, tick: number | null, ratio: number): FootprintBar {
  const vap = new Map<number, [number, number]>();
  let complete = records.length === barMinutes;
  const sources = new Set<"live" | "recorded">();
  for (const r of records) {
    if (!r?.complete) complete = false;
    if (!r) continue;
    sources.add(r.source);
    for (const [p, bid, ask] of r.vap) {
      const v = vap.get(p) ?? [0, 0];
      v[0] += bid;
      v[1] += ask;
      vap.set(p, v);
    }
  }
  const at = (p: number) => vap.get(key(p));
  const levels: FootprintLevel[] = [...vap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([price, [bidVolume, askVolume]]) => {
      let buyImbalance: boolean | null = null;
      let sellImbalance: boolean | null = null;
      if (tick) {
        const below = at(snapToTick(price - tick, tick, "nearest"))?.[0] ?? 0;
        const above = at(snapToTick(price + tick, tick, "nearest"))?.[1] ?? 0;
        buyImbalance = below > 0 && askVolume >= ratio * below;
        sellImbalance = above > 0 && bidVolume >= ratio * above;
      }
      return { price, bidVolume, askVolume, buyImbalance, sellImbalance };
    });
  let volume = 0;
  let delta = 0;
  let pv = 0;
  for (const l of levels) {
    const v = l.bidVolume + l.askVolume;
    volume += v;
    pv += v * l.price;
    delta += l.askVolume - l.bidVolume;
  }
  // POC: the price with the most volume; a tie goes to the price nearest the bar's VWAP, then to the lower price.
  const vwap = volume > 0 ? pv / volume : 0;
  let poc: number | null = null;
  let pocVol = -1;
  for (const l of levels) {
    const v = l.bidVolume + l.askVolume;
    const better =
      v > pocVol ||
      (v === pocVol && poc !== null && (Math.abs(l.price - vwap) < Math.abs(poc - vwap) - 1e-9 || (Math.abs(Math.abs(l.price - vwap) - Math.abs(poc - vwap)) <= 1e-9 && l.price < poc)));
    if (better) {
      pocVol = v;
      poc = l.price;
    }
  }
  return { t: new Date(start).toISOString(), complete, minutes: barMinutes, volume, delta, poc, levels, sources: [...sources] };
}

/**
 * Merge live and recorded records for the same minutes: a complete recorded
 * minute replaces a live one that is not complete; a complete live minute is
 * kept; a minute only one side has is taken from it.
 */
export function mergeRecords(live: MinuteRecord[], recorded: MinuteRecord[]): Map<number, MinuteRecord> {
  const out = new Map<number, MinuteRecord>();
  for (const r of live) out.set(r.t, r);
  for (const r of recorded) {
    const cur = out.get(r.t);
    if (!cur || (!cur.complete && r.complete)) out.set(r.t, r);
  }
  return out;
}

/** Runs of minutes in [from, to] that are missing or incomplete, as {from, to} ISO intervals (to exclusive). */
export function gapsOf(byMinute: ReadonlyMap<number, MinuteRecord>, from: number, to: number): Array<{ from: string; to: string; minutes: number }> {
  const gaps: Array<{ from: string; to: string; minutes: number }> = [];
  let start: number | null = null;
  const close = (end: number) => {
    if (start !== null) gaps.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), minutes: (end - start) / MINUTE_MS });
    start = null;
  };
  for (let t = minuteOf(from); t <= to; t += MINUTE_MS) {
    if (byMinute.get(t)?.complete) close(t);
    else start ??= t;
  }
  close(minuteOf(to) + MINUTE_MS);
  return gaps;
}
