/**
 * The live order-flow feed: per-contract state built from the market hub's
 * trades (GatewayTrade), L2 depth (GatewayDepth) and quotes (GatewayQuote).
 * Used by the MCP servers (lazy, on the first flow tool call) and by the
 * recorder (its symbols, re-resolved at each trading-day start).
 */
import type { ApiEnvelope, PostOptions, ProjectXClient } from "./client.js";
import {
  Book,
  DOM_TYPE,
  MINUTE_MS,
  Ring,
  FINALIZE_GRACE_MS,
  CLOCK_BEHIND_WARN_MS,
  MAX_RECORDER_GRACE_MS,
  MAX_SKEW_GRACE_MS,
  RECORDER_GRACE_MS,
  SILENCE_LIMIT_MS,
  addPrint,
  median,
  minuteComplete,
  minuteDecided,
  minuteOf,
  newBucket,
  lagWindowMs,
  quoteShortfall,
  tradeFeedCheck,
  ofiEvent,
  parseDepth,
  parseTrades,
  recordOf,
  type L1Event,
  type Level,
  type LevelChange,
  type FeedCoverage,
  type LiveInterval,
  type MinuteBucket,
  type MinuteRecord,
  type Print,
} from "./orderflow.js";
import type { FeedKind, FlowHub, Quote } from "./realtime.js";
import { realTimers, type Timers } from "./reconcile.js";
import { symbolRoot, tradingDayStart } from "./risk.js";

export const FLOW_LIMITS = Object.freeze({
  maxContracts: 6,
  prints: 5_000,
  l1Events: 10_000,
  depthChanges: 20_000,
  /** Minute rows and live intervals kept per contract. */
  historyMs: 24 * 3600_000,
  maxIntervals: 1_000,
  silences: 1_000,
  /** Recent prints whose receive-minus-exchange delay gives the skew. */
  skewSamples: 101,
});

/** A first flow call waits at most this long for its subscriptions. */
export const SUBSCRIBE_WAIT_MS = 5_000;
/** The tick-size lookup a flow tool makes is bounded by this. */
export const TICK_LOOKUP_MS = 2_000;
/** The contract check before a first subscribe is bounded by this (with the two above, a flow tool answers within 10 s). */
export const VALIDATE_MS = 2_000;
/** Maintenance timer: missing subscriptions, the roll, finalized minutes, pruning. */
export const FLOW_TICK_MS = 5_000;
/** A symbol that failed to resolve is tried again after this. */
export const RESOLVE_RETRY_MS = 60_000;

const KINDS: readonly FeedKind[] = ["trades", "depth", "quotes"];

export class FlowCapError extends Error {}

export interface TickLookup {
  get(contractId: string, opts?: PostOptions): Promise<number | null>;
}

export interface FlowFeedOptions {
  hub: FlowHub;
  now?: () => number;
  ticks?: TickLookup;
  warn?: (line: string) => void;
  maxContracts?: number;
  /** Levels per side in the per-minute book imbalance. */
  bookLevels?: number;
  /** Root symbol → active contract id (needed for `setSymbols`). */
  resolve?: (symbol: string) => Promise<string | null>;
  /** Called once per complete minute after it is final (the recorder writes it). Without it nothing is finalized. */
  onMinute?: (contractId: string, record: MinuteRecord) => void;
  timers?: Timers;
  /** How long a first call waits for its subscriptions (default SUBSCRIBE_WAIT_MS). */
  subscribeWaitMs?: number;
  /** Checks a contract id before its first subscribe: false = unknown (refused), null = could not tell (allowed). */
  validate?: (contractId: string) => Promise<boolean | null>;
  /** Forget a contract whose trade subscribe failed on first use instead of retrying it (MCP mode; default true). */
  dropFailedSubscribes?: boolean;
}

interface ContractState {
  id: string;
  addedAt: number;
  live: Record<FeedKind, boolean>;
  intervals: LiveInterval[];
  buckets: Map<number, MinuteBucket>;
  prints: Ring<Print>;
  l1: Ring<L1Event>;
  depthChanges: Ring<LevelChange>;
  book: Book;
  /** Previous sized L1 state for quote OFI; null after a reset or disconnect. */
  ofiPrev: L1Event | null;
  /** Book imbalance in effect since `t` (integrated into minutes as time passes). */
  imb: { t: number; v: number | null };
  quote: { bid: number | null; ask: number | null; last: number | null; t: number } | null;
  bidChangedAt: number | null;
  askChangedAt: number | null;
  badTimestamps: number;
  skippedItems: number;
  /** Prints for an already-finalized minute: counted, never applied. */
  latePrints: number;
  /** Prints from before the current live interval (replayed on resubscribe): ignored. */
  replayedPrints: number;
  sidelessVolume: number;
  warned: Set<string>;
  /** Receive time of the last hub message for this contract, and the long silences between messages. */
  lastMsg: number | null;
  /** Receive time of the last trade message (the trade watermark). */
  lastTrade: number | null;
  silences: Array<{ from: number; to: number }>;
  /** Last GatewayQuote session volume and lastPrice, and when a volume was first seen. */
  qv: number | null;
  firstQvAt: number | null;
  lastPrice: number | null;
  /** Covered minutes the quote feed contradicts (a dead or lagging trade feed). */
  tradeFeedMismatch: number;
  /** Receive minus exchange time of recent prints (ms). */
  skews: Ring<number>;
  finalizedThrough: number | null;
  /** Coverage verdict of each finalized minute: fixed once decided, so a reported row never changes. */
  verdicts: Map<number, boolean>;
  subscribing: Promise<void> | null;
  /** The last subscribe error per feed (cleared when it succeeds). */
  errors: Partial<Record<FeedKind, string>>;
}

const iso = (t: number | null | undefined) => (t === null || t === undefined ? null : new Date(t).toISOString());

/** Whether a contract id exists, through Contract/searchById: false when the broker says no, null when it could not be checked. */
export async function contractExists(client: Pick<ProjectXClient, "post">, contractId: string): Promise<boolean | null> {
  try {
    const res = await client.post<ApiEnvelope & { contract?: unknown }>("/api/Contract/searchById", { contractId }, { allowFailure: true, timeoutMs: VALIDATE_MS, deadline: Date.now() + VALIDATE_MS });
    return res.success === true && typeof res.contract === "object" && res.contract !== null;
  } catch {
    return null;
  }
}

/** The active contract for a root symbol through the REST contract search (activeContract=true, same root). */
export async function resolveActiveContract(client: Pick<ProjectXClient, "post">, symbol: string): Promise<string | null> {
  const res = await client.post<ApiEnvelope & { contracts?: Array<{ id?: unknown; activeContract?: unknown }> }>("/api/Contract/search", { searchText: symbol, live: false });
  const root = symbol.toUpperCase();
  const hit = (res.contracts ?? []).find((c) => typeof c.id === "string" && c.activeContract === true && symbolRoot(c.id) === root);
  return (hit?.id as string | undefined) ?? null;
}

export class FlowFeed {
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private readonly timers: Timers;
  readonly maxContracts: number;
  private readonly bookLevels: number;
  private readonly states = new Map<string, ContractState>();
  private readonly removeListener: () => void;
  private handle: unknown = null;
  private running: Promise<void> | null = null;
  private symbols: string[] = [];
  /** Symbol → the contract it resolved to this trading day. */
  readonly bySymbol = new Map<string, string>();
  private resolvedSession: number | null = null;
  private retryResolveAt = 0;
  private closed = false;
  private lastTickAt: number | null = null;

  constructor(private readonly o: FlowFeedOptions) {
    this.now = o.now ?? Date.now;
    this.warn = o.warn ?? ((line) => console.error(`[projectx-mcp] ${line}`));
    this.timers = o.timers ?? realTimers;
    this.maxContracts = o.maxContracts ?? FLOW_LIMITS.maxContracts;
    this.bookLevels = o.bookLevels ?? 5;
    this.removeListener = o.hub.addListener({
      trade: (id, data) => this.onTrade(id, data),
      depth: (id, data) => this.onDepth(id, data),
      quote: (id, data) => this.onQuote(id, data),
      subscribed: (kind, id) => this.onSubscribed(kind, id),
      down: () => this.onDown(),
    });
  }

  /** Contracts with flow state (subscribed or being subscribed). */
  contracts(): string[] {
    return [...this.states.keys()];
  }

  // ── Hub events ──────────────────────────────────────────────────────

  private bucket(st: ContractState, t: number): MinuteBucket {
    const m = minuteOf(t);
    let b = st.buckets.get(m);
    if (!b) st.buckets.set(m, (b = newBucket(m)));
    return b;
  }

  /** Warn once per contract and kind of problem. */
  private warnOnce(st: ContractState, key: string, line: string): void {
    if (st.warned.has(key)) return;
    st.warned.add(key);
    this.warn(line);
  }

  /** Any hub message for the contract: moves the watermark and records a long silence before it. */
  private touch(st: ContractState, now: number): void {
    if (st.lastMsg !== null && now - st.lastMsg > SILENCE_LIMIT_MS) {
      st.silences.push({ from: st.lastMsg, to: now });
      if (st.silences.length > FLOW_LIMITS.silences) st.silences.shift();
    }
    if (st.lastMsg === null || now > st.lastMsg) st.lastMsg = now;
  }

  /** The short grace: FINALIZE_GRACE_MS plus the positive median print delay, capped. */
  private graceMs(st: ContractState): number {
    return FINALIZE_GRACE_MS + Math.min(MAX_SKEW_GRACE_MS, Math.max(0, median(st.skews.toArray())));
  }

  /** The settle grace without a later trade message: RECORDER_GRACE_MS plus the positive median delay, capped. */
  private settleMs(st: ContractState): number {
    return Math.min(MAX_RECORDER_GRACE_MS, RECORDER_GRACE_MS + Math.max(0, median(st.skews.toArray())));
  }

  private cov(st: ContractState): FeedCoverage {
    return {
      intervals: st.intervals,
      lastMsg: st.lastMsg,
      silences: st.silences,
      graceMs: this.graceMs(st),
      lastTrade: st.lastTrade,
      settleMs: this.settleMs(st),
      skewMs: median(st.skews.toArray()),
    };
  }

  /** A minute's verdict: covered by the feed (minuteComplete) and not contradicted by the quote feed's volume and last price. */
  private verdict(st: ContractState, t: number, cov: FeedCoverage, now: number): { covered: boolean; check: ReturnType<typeof tradeFeedCheck> } {
    const covered = minuteComplete(t, cov, now);
    const carried = (m: number) => st.firstQvAt !== null && st.firstQvAt < m;
    // The previous minute's shortfall carries in only within one continuous live interval, and only one minute back.
    const prev = t - MINUTE_MS;
    const continuous = cov.intervals.some((iv) => iv.from <= prev && (iv.to === null || iv.to >= t + MINUTE_MS));
    const carryIn = continuous ? quoteShortfall(st.buckets.get(prev) ?? newBucket(prev), carried(prev)) : 0;
    const check = tradeFeedCheck(st.buckets.get(t) ?? newBucket(t), carried(t), carryIn);
    return { covered: covered && check === "ok", check };
  }

  private onTrade(id: string, data: unknown): void {
    const st = this.states.get(id);
    if (!st) return;
    const now = this.now();
    this.touch(st, now);
    st.lastTrade = now;
    const parsed = parseTrades(data, now);
    st.badTimestamps += parsed.badTimestamps;
    st.skippedItems += parsed.skipped;
    const last = st.intervals[st.intervals.length - 1];
    for (const p of parsed.items) {
      // Before the current live interval (or inside a known drop): a replay on resubscribe, already counted or unknown.
      if (last && p.t < (last.to === null ? last.from : last.to)) {
        st.replayedPrints++;
        continue;
      }
      if (!p.badTimestamp) {
        st.skews.push(now - p.t);
        if (median(st.skews.toArray()) < CLOCK_BEHIND_WARN_MS) {
          this.warnOnce(st, "behind", `order flow: ${id}: this machine's clock is behind the exchange's (prints arrive before their timestamps); minutes right after a subscribe are held incomplete`);
        }
      }
      st.prints.push(p);
      if (st.finalizedThrough !== null && minuteOf(p.t) <= st.finalizedThrough) {
        st.latePrints++;
        this.warnOnce(st, "late", `order flow: ${id}: a print arrived after its minute was final (${iso(p.t)}); it is counted in latePrints and not applied`);
        continue;
      }
      if (!p.side) {
        st.sidelessVolume += p.size;
        this.warnOnce(st, "sideless", `order flow: ${id}: a print with no known aggressor side; its minute is not complete`);
      }
      addPrint(this.bucket(st, p.t), p);
    }
  }

  /** Integrate the book imbalance in effect up to `t` into the minutes it spans. */
  private advanceImbalance(st: ContractState, t: number): void {
    const v = st.imb.v;
    let from = Math.max(st.imb.t, t - FLOW_LIMITS.historyMs);
    st.imb.t = Math.max(st.imb.t, t);
    if (v === null) return;
    while (from < t) {
      const end = Math.min(minuteOf(from) + MINUTE_MS, t);
      const b = this.bucket(st, from);
      b.imbArea += v * (end - from);
      b.imbMs += end - from;
      from = end;
    }
  }

  /** Append an L1 state when it differs from the last one; returns whether it did. */
  private pushL1(st: ContractState, ev: L1Event): boolean {
    const prev = st.l1.latest();
    if (prev && prev.source === ev.source && prev.bid === ev.bid && prev.bidSize === ev.bidSize && prev.ask === ev.ask && prev.askSize === ev.askSize) return false;
    if (!prev || prev.bid !== ev.bid || prev.bidSize !== ev.bidSize) st.bidChangedAt = ev.t;
    if (!prev || prev.ask !== ev.ask || prev.askSize !== ev.askSize) st.askChangedAt = ev.t;
    st.l1.push(ev);
    return true;
  }

  private onDepth(id: string, data: unknown): void {
    const st = this.states.get(id);
    if (!st) return;
    const now = this.now();
    this.touch(st, now);
    const parsed = parseDepth(data, now);
    st.badTimestamps += parsed.badTimestamps;
    st.skippedItems += parsed.skipped;
    if (!parsed.items.length) return;
    this.advanceImbalance(st, now);
    for (const e of parsed.items) {
      if (e.type === DOM_TYPE.Reset) st.ofiPrev = null;
      for (const c of st.book.apply(e, now)) st.depthChanges.push(c);
    }
    st.imb.v = st.book.imbalance(this.bookLevels);
    if (!st.book.valid) return;
    const bid = st.book.best("bid");
    const ask = st.book.best("ask");
    const ev: L1Event = { t: now, bid: bid?.price ?? null, bidSize: bid?.size ?? null, ask: ask?.price ?? null, askSize: ask?.size ?? null, source: "depth" };
    if (!this.pushL1(st, ev)) return;
    // Quote OFI: Cont-Kukanov-Stoikov e_n between consecutive sized top-of-book states.
    if (st.ofiPrev) {
      const e = ofiEvent(st.ofiPrev, ev);
      if (e !== null) {
        const b = this.bucket(st, now);
        b.ofiQuote += e;
        b.ofiEvents += 1;
      }
    }
    st.ofiPrev = ev;
  }

  private onQuote(id: string, data: Quote): void {
    const st = this.states.get(id);
    if (!st) return;
    const now = this.now();
    this.touch(st, now);
    const n = (v: unknown, prev: number | null) => (typeof v === "number" && Number.isFinite(v) ? v : prev);
    const q = st.quote;
    st.quote = { bid: n(data.bestBid, q?.bid ?? null), ask: n(data.bestAsk, q?.ask ?? null), last: n(data.lastPrice, q?.last ?? null), t: now };
    // The trade-feed cross-check: session volume and last price per minute.
    const b = this.bucket(st, now);
    if (typeof data.volume === "number" && Number.isFinite(data.volume)) {
      if (b.qvSamples === 0) b.qvOpen = st.qv;
      if (now - minuteOf(now) <= lagWindowMs(median(st.skews.toArray()))) b.qvWin = data.volume;
      b.qvClose = data.volume;
      b.qvSamples += 1;
      st.qv = data.volume;
      st.firstQvAt ??= now;
    }
    if (typeof data.lastPrice === "number" && Number.isFinite(data.lastPrice)) {
      if (st.lastPrice !== null && data.lastPrice !== st.lastPrice) {
        // A change just after the boundary to the previous minute's last print price is that print's quote, arriving late.
        const m = minuteOf(now);
        const prevPrint = st.buckets.get(m - MINUTE_MS)?.lastPrintPrice ?? null;
        const late = now - m <= lagWindowMs(median(st.skews.toArray()));
        if (!(late && prevPrint === data.lastPrice)) b.lastPriceChanged = true;
      }
      st.lastPrice = data.lastPrice;
    }
    // Without a book, the quote's best bid/ask (no sizes) are the L1 history.
    if (!st.book.valid) this.pushL1(st, { t: now, bid: st.quote.bid, bidSize: null, ask: st.quote.ask, askSize: null, source: "quote" });
  }

  private onSubscribed(kind: FeedKind, id: string): void {
    const st = this.states.get(id);
    if (!st) return;
    st.live[kind] = true;
    if (kind !== "trades") return;
    const last = st.intervals[st.intervals.length - 1];
    if (!last || last.to !== null) st.intervals.push({ from: this.now(), to: null });
    if (st.intervals.length > FLOW_LIMITS.maxIntervals) st.intervals.shift();
  }

  /** End the open live interval at the last message received (the drop may have started any time after it). */
  private endInterval(st: ContractState, now: number): void {
    const last = st.intervals[st.intervals.length - 1];
    if (last && last.to === null) last.to = Math.max(last.from, Math.min(now, st.lastMsg ?? last.from));
  }

  private onDown(): void {
    const now = this.now();
    for (const st of this.states.values()) {
      this.endInterval(st, now);
      for (const k of KINDS) st.live[k] = false;
      this.advanceImbalance(st, now);
      // The book is rebuilt from the next snapshot after the resubscribe.
      st.book.clear();
      st.book.lastUpdate = now;
      st.depthChanges.push({ t: now, side: null, price: null, size: 0, prevSize: 0, type: DOM_TYPE.Reset });
      st.imb.v = null;
      st.ofiPrev = null;
    }
  }

  // ── Subscriptions ───────────────────────────────────────────────────

  private subscribeMissing(st: ContractState): Promise<void> {
    st.subscribing ??= (async () => {
      for (const kind of KINDS) {
        if (st.live[kind] || this.closed) continue;
        try {
          await this.o.hub.subscribe(kind, st.id);
          delete st.errors[kind];
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (st.errors[kind] !== msg) this.warn(`order flow: subscribing ${kind} for ${st.id} failed: ${msg}`);
          st.errors[kind] = msg;
        }
      }
    })().finally(() => {
      st.subscribing = null;
    });
    return st.subscribing;
  }

  /**
   * Start the feeds for a contract on first use (within the contract cap) and
   * wait up to `waitMs` for the subscriptions. Data starts now; nothing before.
   */
  async ensure(contractId: string, waitMs = this.o.subscribeWaitMs ?? SUBSCRIBE_WAIT_MS): Promise<void> {
    let st = this.states.get(contractId);
    if (!st && this.o.validate) {
      this.checkCap();
      const ok = await this.o.validate(contractId).catch(() => null);
      if (ok === false) throw new Error(`Unknown contract ${contractId}: Contract/searchById does not know it. Use search_contracts for the id.`);
      st = this.states.get(contractId);
    }
    if (!st) {
      this.checkCap();
      const now = this.now();
      st = {
        id: contractId,
        addedAt: now,
        live: { trades: false, depth: false, quotes: false },
        intervals: [],
        buckets: new Map(),
        prints: new Ring(FLOW_LIMITS.prints),
        l1: new Ring(FLOW_LIMITS.l1Events),
        depthChanges: new Ring(FLOW_LIMITS.depthChanges),
        book: new Book(),
        ofiPrev: null,
        imb: { t: now, v: null },
        quote: null,
        bidChangedAt: null,
        askChangedAt: null,
        badTimestamps: 0,
        skippedItems: 0,
        finalizedThrough: null,
        verdicts: new Map(),
        subscribing: null,
        errors: {},
        latePrints: 0,
        replayedPrints: 0,
        sidelessVolume: 0,
        warned: new Set(),
        lastMsg: null,
        lastTrade: null,
        silences: [],
        qv: null,
        firstQvAt: null,
        lastPrice: null,
        tradeFeedMismatch: 0,
        skews: new Ring(FLOW_LIMITS.skewSamples),
      };
      this.states.set(contractId, st);
      this.startTimer();
    }
    const state = st;
    if (KINDS.every((k) => state.live[k])) return;
    const firstUse = state.intervals.length === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      this.subscribeMissing(state).then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), waitMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    // A first subscribe the hub refused (e.g. an unknown contract) must not hold a slot or be retried forever.
    if (done && firstUse && !state.live.trades && state.errors.trades && (this.o.dropFailedSubscribes ?? true)) {
      await this.drop(contractId, false);
      throw new Error(`Could not subscribe to ${contractId}: ${state.errors.trades}`);
    }
  }

  private checkCap(): void {
    if (this.states.size >= this.maxContracts) {
      throw new FlowCapError(`Order-flow subscriptions are capped at ${this.maxContracts} contracts; already subscribed: ${this.contracts().join(", ")}.`);
    }
  }

  /** Stop a contract's feeds and forget its state (after finalizing what is final). */
  async drop(contractId: string, finalize = true): Promise<void> {
    const st = this.states.get(contractId);
    if (!st) return;
    if (finalize) this.finalize(st);
    this.states.delete(contractId);
    for (const kind of KINDS) await this.o.hub.unsubscribe(kind, contractId).catch(() => {});
  }

  /** The recorder's root symbols: resolved now and again at each trading-day start. */
  setSymbols(symbols: string[]): void {
    this.symbols = symbols.map((s) => s.toUpperCase());
  }

  private async roll(): Promise<void> {
    const resolve = this.o.resolve;
    if (!resolve) return;
    this.resolvedSession = tradingDayStart(new Date(this.now())).getTime();
    let failed = false;
    for (const symbol of this.symbols) {
      let id: string | null = null;
      try {
        id = await resolve(symbol);
      } catch (e) {
        this.warn(`order flow: resolving ${symbol} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!id) {
        failed = true;
        if (!this.bySymbol.has(symbol)) this.warn(`order flow: no active contract for ${symbol}; retrying`);
        continue;
      }
      const old = this.bySymbol.get(symbol);
      if (old === id) continue;
      if (old) {
        this.warn(`order flow: ${symbol} rolled from ${old} to ${id}`);
        await this.drop(old);
      }
      this.bySymbol.set(symbol, id);
      try {
        await this.ensure(id);
      } catch (e) {
        this.warn(`order flow: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.retryResolveAt = failed ? this.now() + RESOLVE_RETRY_MS : Infinity;
  }

  /**
   * Finalize each minute once its completeness can no longer change: a complete
   * one is emitted to onMinute (the recorder writes it). After that, prints for
   * it are late and never applied, so a reported or recorded row never changes.
   */
  private finalize(st: ContractState): void {
    const first = st.intervals[0];
    if (!first) return;
    const now = this.now();
    this.advanceImbalance(st, now);
    const cov = this.cov(st);
    let t = st.finalizedThrough === null ? minuteOf(first.from) : st.finalizedThrough + MINUTE_MS;
    t = Math.max(t, minuteOf(now - FLOW_LIMITS.historyMs));
    for (; minuteDecided(t, cov, now); t += MINUTE_MS) {
      st.finalizedThrough = t;
      const v = this.verdict(st, t, cov, now);
      const covered = v.covered;
      if (minuteComplete(t, cov, now) && v.check === "mismatch") {
        st.tradeFeedMismatch++;
        this.warnOnce(st, "mismatch", `order flow: ${st.id}: the quote feed shows trading the trade feed did not deliver (${iso(t)}); such minutes are incomplete (tradeFeedMismatch)`);
      }
      st.verdicts.set(t, covered);
      const rec = recordOf(st.buckets.get(t) ?? newBucket(t), covered);
      if (!rec.complete || !this.o.onMinute) continue;
      try {
        this.o.onMinute(st.id, rec);
      } catch (e) {
        this.warn(`order flow: recording ${st.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private prune(st: ContractState): void {
    const cutoff = this.now() - FLOW_LIMITS.historyMs;
    for (const t of st.buckets.keys()) if (t + MINUTE_MS < cutoff) st.buckets.delete(t);
    for (const t of st.verdicts.keys()) if (t + MINUTE_MS < cutoff) st.verdicts.delete(t);
    while (st.intervals.length > 1 && st.intervals[0].to !== null && st.intervals[0].to < cutoff) st.intervals.shift();
    while (st.silences.length && st.silences[0].to < cutoff) st.silences.shift();
  }

  /** One maintenance pass: retry missing subscriptions, roll at the trading-day start, finalize minutes, prune. */
  tick(): Promise<void> {
    this.running ??= (async () => {
      const now = this.now();
      // A clock jump (sleep or stall) means nothing was watched in between: treat it as a disconnect from the last message.
      if (this.lastTickAt !== null && now - this.lastTickAt > 2 * FLOW_TICK_MS) {
        for (const st of this.states.values()) {
          const open = st.intervals[st.intervals.length - 1];
          if (!open || open.to !== null) continue;
          this.endInterval(st, now);
          st.intervals.push({ from: now, to: null });
          this.warnOnce(st, `jump-${now}`, `order flow: ${st.id}: the clock jumped ${Math.round((now - this.lastTickAt) / 1000)} s; the time since the last message is a gap`);
        }
      }
      this.lastTickAt = now;
      if (this.symbols.length && (this.resolvedSession !== tradingDayStart(new Date(now)).getTime() || now >= this.retryResolveAt)) await this.roll();
      for (const st of this.states.values()) {
        if (!KINDS.every((k) => st.live[k])) void this.subscribeMissing(st);
        this.finalize(st);
        this.prune(st);
      }
    })()
      .catch((e) => this.warn(`order flow: maintenance failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private startTimer(): void {
    if (this.handle !== null || this.closed) return;
    this.handle = this.timers.every(FLOW_TICK_MS, () => void this.tick());
  }

  /** Start the maintenance timer and run the first pass now (the recorder; MCP servers start it lazily). */
  async start(): Promise<void> {
    this.startTimer();
    await this.tick();
  }

  /** Stop the timer and the feeds; `finalize: false` skips the last minutes (the recorder lost its lock). */
  async close(opts: { finalize?: boolean } = {}): Promise<void> {
    this.closed = true;
    if (this.handle !== null) this.timers.cancel(this.handle);
    this.handle = null;
    await this.running;
    for (const id of this.contracts()) await this.drop(id, opts.finalize ?? true);
    this.removeListener();
  }

  // ── Queries ─────────────────────────────────────────────────────────

  private state(contractId: string): ContractState {
    const st = this.states.get(contractId);
    if (!st) throw new Error(`No order-flow subscription for ${contractId}.`);
    return st;
  }

  /** The contract's tick size (bounded lookup); null when unknown. */
  async tickSize(contractId: string): Promise<number | null> {
    if (!this.o.ticks) return null;
    return this.o.ticks.get(contractId, { timeoutMs: TICK_LOOKUP_MS, deadline: Date.now() + TICK_LOOKUP_MS }).catch(() => null);
  }

  /** Live minute records for every minute in [from, to] since the feed started. */
  records(contractId: string, from: number, to: number): MinuteRecord[] {
    const st = this.state(contractId);
    this.finalize(st);
    const now = this.now();
    const cov = this.cov(st);
    const first = st.intervals[0] ? minuteOf(st.intervals[0].from) : minuteOf(st.addedAt);
    const out: MinuteRecord[] = [];
    for (let t = Math.max(minuteOf(from), first); t <= to; t += MINUTE_MS) {
      out.push(recordOf(st.buckets.get(t) ?? newBucket(t), st.verdicts.get(t) ?? this.verdict(st, t, cov, now).covered));
    }
    return out;
  }

  /** Subscription status and live coverage of a contract. */
  coverage(contractId: string) {
    const st = this.state(contractId);
    const open = st.intervals[st.intervals.length - 1];
    return {
      subscribedAt: iso(st.addedAt),
      tradesLive: st.live.trades,
      depthLive: st.live.depth,
      quotesLive: st.live.quotes,
      liveSince: open && open.to === null ? iso(open.from) : null,
      disconnects: st.intervals.filter((iv) => iv.to !== null).map((iv) => iso(iv.to)),
      errors: { ...st.errors },
      lastMessage: iso(st.lastMsg),
      lastTrade: iso(st.lastTrade),
      silences: st.silences.filter((g) => g.to >= this.now() - FLOW_LIMITS.historyMs).map((g) => ({ from: iso(g.from), to: iso(g.to) })),
      graceMs: this.graceMs(st),
      settleMs: this.settleMs(st),
      skewMs: median(st.skews.toArray()),
      decidedThrough: iso(st.finalizedThrough),
      tradeFeedMismatch: st.tradeFeedMismatch,
      badTimestamps: st.badTimestamps,
      skippedItems: st.skippedItems,
      latePrints: st.latePrints,
      replayedPrints: st.replayedPrints,
      sidelessVolume: st.sidelessVolume,
    };
  }

  prints(contractId: string, opts: { limit: number; since?: number }): Print[] {
    const st = this.state(contractId);
    const all = st.prints.toArray();
    const filtered = opts.since === undefined ? all : all.filter((p) => p.t >= opts.since!);
    return filtered.slice(Math.max(0, filtered.length - opts.limit));
  }

  async depth(contractId: string, opts: { levels: number; imbalanceLevels: number; history?: number }) {
    const st = this.state(contractId);
    const tick = await this.tickSize(contractId);
    const now = this.now();
    const side = (levels: Level[]) => {
      let cum = 0;
      return levels.map((l) => ({ price: l.price, size: l.size, cumSize: (cum += l.size) }));
    };
    // A partial book (one side only so far) shows what it has, flagged.
    const bids = st.book.levels("bid", opts.levels);
    const asks = st.book.levels("ask", opts.levels);
    const bestBid = bids[0] ?? null;
    const bestAsk = asks[0] ?? null;
    return {
      contractId,
      valid: st.book.valid,
      partial: st.book.partial,
      snapshot: st.book.snapshot,
      lastUpdate: iso(st.book.lastUpdate),
      ageMs: st.book.lastUpdate === null ? null : now - st.book.lastUpdate,
      bestBid,
      bestAsk,
      spreadTicks: bestBid && bestAsk && tick ? Math.round((bestAsk.price - bestBid.price) / tick) : null,
      imbalanceLevels: opts.imbalanceLevels,
      imbalance: st.book.imbalance(opts.imbalanceLevels),
      totalLevels: { bids: st.book.bids.size, asks: st.book.asks.size },
      bids: side(bids),
      asks: side(asks),
      ...(opts.history ? { history: st.depthChanges.last(opts.history).map((c) => ({ ...c, t: iso(c.t) })) } : {}),
    };
  }

  async topOfBook(contractId: string, history?: number) {
    const st = this.state(contractId);
    const tick = await this.tickSize(contractId);
    const now = this.now();
    const part = (which: "bid" | "ask") => {
      const fromBook = st.book.valid ? st.book.best(which) : null;
      const changedAt = which === "bid" ? st.bidChangedAt : st.askChangedAt;
      if (fromBook) return { price: fromBook.price, size: fromBook.size, source: "depth" as const, t: iso(changedAt), ageMs: changedAt === null ? null : now - changedAt };
      const q = st.quote?.[which];
      if (q !== null && q !== undefined) return { price: q, size: null, source: "quote" as const, t: iso(st.quote!.t), ageMs: now - st.quote!.t };
      return null;
    };
    const bid = part("bid");
    const ask = part("ask");
    const p = st.prints.latest();
    const last = p
      ? { price: p.price, size: p.size, side: p.side, source: "trades" as const, t: iso(p.t), ageMs: now - p.t }
      : st.quote?.last !== null && st.quote?.last !== undefined
        ? { price: st.quote.last, size: null, side: null, source: "quote" as const, t: iso(st.quote.t), ageMs: now - st.quote.t }
        : null;
    return {
      contractId,
      bid,
      ask,
      last,
      spreadTicks: bid && ask && tick ? Math.round((ask.price - bid.price) / tick) : null,
      mid: bid && ask ? Number(((bid.price + ask.price) / 2).toFixed(10)) : null,
      bookValid: st.book.valid,
      ...(history ? { history: st.l1.last(history).map((e) => ({ ...e, t: iso(e.t) })) } : {}),
    };
  }
}
