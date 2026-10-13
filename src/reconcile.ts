import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiEnvelope, PostOptions, ProjectXClient } from "./client.js";
import { MIN_RECONCILE_SECONDS, reconcileInterval, type Config } from "./config.js";
import { ORDER_TYPES, SIDES } from "./enums.js";
import { ORDER_KINDS, type Journal } from "./journal.js";
import { CALL_BUDGET_MS, positionOn, protectionFlow, type FlattenResult } from "./protect.js";
import { assertTradingAllowed, tradingDayStart } from "./risk.js";

type Row = Record<string, unknown>;

/** Each account's reads in a cycle must finish within this (its own deadline). */
export const ACCOUNT_READ_BUDGET_MS = 8_000;
/** After the broker definitively refused a close, that contract is not tried again for this long. */
export const FAILED_FLATTEN_BACKOFF_MS = 5 * 60_000;
/** After a close that failed without a definitive refusal (no reply, not flat in time): 1, 2, then 5 min. */
export const UNCERTAIN_BACKOFF_MS = [60_000, 120_000, 300_000];
/** The own-trade window reaches back at least this far, so an overnight hold stays in scope across the 17:00 CT boundary. */
export const SCOPE_MIN_MS = 24 * 60 * 60_000;
/** Cap on each read request. */
const READ_CAP_MS = 3_000;
/** A flatten's close request may take this long; the flatten itself has CALL_BUDGET_MS. */
const CLOSE_CAP_MS = 4_000;
const STOP_TYPES: number[] = [ORDER_TYPES.stop, ORDER_TYPES.trailing_stop];

export interface Cover {
  contractId: string;
  /** Total open size, whatever the direction. */
  size: number;
  /** From the position type, or inferred from the stops' side when the type is unknown. */
  direction: "long" | "short" | null;
  directionInferred: boolean;
  /** Size of the working stops on the side opposite the position. */
  stopSize: number;
  covered: boolean;
}

/**
 * For each contract with an open position: is it covered by working stop or
 * trailing_stop orders on the opposite side, summing to at least its total size?
 * An unknown direction is read from the stops when they are all on one side
 * (a sell stop means long). No stops, or stops on both sides, is uncovered.
 */
export function coverage(positions: Row[], orders: Row[]): Cover[] {
  const ids = [...new Set(positions.filter((p) => Math.abs(Number(p.size) || 0) > 0).map((p) => p.contractId as string))];
  return ids.map((contractId) => {
    const st = positionOn(positions, contractId);
    const stops = orders.filter((o) => o.contractId === contractId && STOP_TYPES.includes(o.type as number));
    let direction: Cover["direction"] = st.net !== null && st.net !== 0 ? (st.net > 0 ? "long" : "short") : null;
    let directionInferred = false;
    if (direction === null) {
      const sides = new Set(stops.map((o) => o.side));
      if (sides.size === 1) {
        const only = [...sides][0];
        direction = only === SIDES.sell ? "long" : only === SIDES.buy ? "short" : null;
        directionInferred = direction !== null;
      }
    }
    const coverSide = direction === "long" ? SIDES.sell : direction === "short" ? SIDES.buy : null;
    const stopSize = coverSide === null ? 0 : stops.filter((o) => o.side === coverSide).reduce((n, o) => n + (Number(o.size) || 0), 0);
    return { contractId, size: st.size, direction, directionInferred, stopSize, covered: coverSide !== null && stopSize >= st.size };
  });
}

interface LockFile {
  pid: number;
  token: string;
  heartbeat: number;
}

export interface LockDeps {
  now: () => number;
  pid?: number;
  /** Whether a process is alive (default: signal 0). */
  isAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One reconciler per lock file may act. The file holds pid, a token and a
 * heartbeat; it is created with an exclusive create, refreshed every cycle,
 * and taken over when its heartbeat is older than `staleMs` or its pid is dead.
 */
export class ReconcileLock {
  private readonly token = randomBytes(8).toString("hex");
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private held = false;

  constructor(
    readonly path: string,
    private readonly staleMs: number,
    private readonly d: LockDeps,
  ) {
    this.pid = d.pid ?? process.pid;
    this.isAlive = d.isAlive ?? pidAlive;
  }

  private read(): LockFile | null | "unreadable" {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
    }
    try {
      const f = JSON.parse(text) as LockFile;
      return typeof f.pid === "number" && typeof f.heartbeat === "number" ? f : "unreadable";
    } catch {
      return "unreadable";
    }
  }

  private body(): string {
    return JSON.stringify({ pid: this.pid, token: this.token, heartbeat: this.d.now() } satisfies LockFile);
  }

  private create(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(this.path, "wx");
      try {
        writeFileSync(fd, this.body());
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** True when the file on disk is this holder's. */
  mine(): boolean {
    const f = this.read();
    return f !== null && f !== "unreadable" && f.token === this.token;
  }

  /** Take the lock, or keep it and refresh its heartbeat. Returns whether this instance holds it. */
  hold(): boolean {
    if (this.held && this.mine()) {
      try {
        const tmp = `${this.path}.${this.token}.tmp`;
        writeFileSync(tmp, this.body());
        renameSync(tmp, this.path);
        return true;
      } catch {
        // could not refresh: fall through and check again
      }
    }
    this.held = false;
    if (this.create()) return (this.held = true);
    const f = this.read();
    let stale: boolean;
    if (f === null) stale = true; // removed between the create and the read
    else if (f === "unreadable") {
      // Being written right now, or garbage: judge it by its age.
      try {
        stale = this.d.now() - statSync(this.path).mtimeMs > this.staleMs;
      } catch {
        stale = true;
      }
    } else stale = this.d.now() - f.heartbeat > this.staleMs || !this.isAlive(f.pid);
    if (!stale) return false;
    try {
      unlinkSync(this.path);
    } catch {
      // someone else took it over first
    }
    if (this.create()) return (this.held = true);
    return false;
  }

  release(): void {
    if (this.held && this.mine()) {
      try {
        unlinkSync(this.path);
      } catch {
        // already gone
      }
    }
    this.held = false;
  }
}

export interface Timers {
  every: (ms: number, fn: () => void) => unknown;
  cancel: (handle: unknown) => void;
}

const realTimers: Timers = {
  every: (ms, fn) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  cancel: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ReconcileDeps {
  config: Config;
  client: Pick<ProjectXClient, "post">;
  /** The shared journal: its order entries decide the scope (own trades only) and the grace after an order. */
  journal: Journal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One stderr line per warning (stdout is the MCP channel). */
  warn?: (line: string) => void;
  timers?: Timers;
  /** Lock file; default `reconcile.lock` next to the journal. */
  lockPath?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export interface CycleReport {
  skipped?: "overlap";
  /** Accounts with an order from this server today (the only ones checked). */
  accounts: number[];
  /** Accounts whose positions or orders could not be read this cycle. */
  unreadable: number[];
  uncovered: Array<{ accountId: number } & Cover>;
  flattened: Array<{ accountId: number; contractId: string; status: FlattenResult["status"] }>;
  holdsLock: boolean;
}

const emptyReport = (): CycleReport => ({ accounts: [], unreadable: [], uncovered: [], flattened: [], holdsLock: false });
const keyOf = (acct: number, contractId: string) => `${acct}|${contractId}`;

/**
 * Protection check on a timer (REST only), for this server's own trades: the
 * account+contract pairs with an order entry in the shared journal since the
 * trading day started. Only the lock holder reads and acts. A position not
 * covered by opposite stops for its whole size is flattened only after it was
 * seen uncovered on two checks at least the grace period apart, with no order
 * from either copy on that contract within the grace period, and after a fresh
 * re-read still shows it open and uncovered. A flatten that does not end flat
 * backs that contract off for FAILED_FLATTEN_BACKOFF_MS.
 */
export class Reconciler {
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private readonly timers: Timers;
  private readonly flow: ReturnType<typeof protectionFlow>;
  readonly lock: ReconcileLock;
  /** The interval in effect, in seconds (0 = off). */
  readonly intervalSeconds: number;
  /** First time each account|contract was seen uncovered in the current streak. */
  private readonly firstUncovered = new Map<string, number>();
  /** No flatten on account|contract before this time (after a failed one). */
  private readonly backoffUntil = new Map<string, number>();
  /** Consecutive failed flattens per account|contract without a definitive refusal. */
  private readonly uncertainFails = new Map<string, number>();
  /** Working orders left after a flatten that ended flat: cancelled again while the contract stays flat. */
  private readonly legsLeft = new Map<string, number[]>();
  private journalWarned = false;
  private running: Promise<CycleReport> | null = null;
  private handle: unknown = null;

  constructor(private readonly d: ReconcileDeps) {
    this.now = d.now ?? Date.now;
    this.warn = d.warn ?? ((line) => console.error(`[projectx-mcp] ${line}`));
    this.timers = d.timers ?? realTimers;
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.flow = protectionFlow({ client: d.client, journal: d.journal, now: this.now, sleep });
    this.intervalSeconds = reconcileInterval(d.config);
    this.lock = new ReconcileLock(d.lockPath ?? join(dirname(d.config.journalPath), "reconcile.lock"), 3 * this.intervalSeconds * 1000, {
      now: this.now,
      pid: d.pid,
      isAlive: d.isAlive,
    });
  }

  /** Whether the reconcile should run at all: trading enabled and a non-zero interval. */
  get enabled(): boolean {
    return this.intervalSeconds > 0;
  }

  get started(): boolean {
    return this.handle !== null;
  }

  /** Start the timer and run the first check now. Returns false (no timer) when disabled. */
  start(): boolean {
    if (!this.enabled || this.handle !== null) return false;
    if (this.intervalSeconds !== this.d.config.reconcileSeconds) {
      this.warn(`reconcile: PROJECTX_RECONCILE_SECONDS=${this.d.config.reconcileSeconds} is below the minimum; using ${MIN_RECONCILE_SECONDS} s`);
    }
    this.handle = this.timers.every(this.intervalSeconds * 1000, () => void this.cycle());
    void this.cycle();
    return true;
  }

  /** Stop the timer, let a running cycle finish, and release the lock. */
  async stop(): Promise<void> {
    if (this.handle !== null) this.timers.cancel(this.handle);
    this.handle = null;
    await this.running; // never rejects: cycle() catches
    this.lock.release();
  }

  /** One check. A call while the previous one still runs is skipped, so cycles never overlap. */
  cycle(): Promise<CycleReport> {
    if (this.running) return Promise.resolve({ ...emptyReport(), skipped: "overlap" });
    this.running = this.run()
      .catch((e): CycleReport => {
        this.warn(`reconcile: cycle failed: ${e instanceof Error ? e.message : String(e)}`);
        return emptyReport();
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async post<T extends ApiEnvelope>(path: string, body: unknown, deadline: number): Promise<T | null> {
    const timeoutMs = Math.min(READ_CAP_MS, deadline - this.now());
    if (timeoutMs < 50) return null;
    const opts: PostOptions = { timeoutMs, deadline };
    try {
      return await this.d.client.post<T>(path, body, opts);
    } catch {
      return null;
    }
  }

  /** Positions and working orders of one account, or null when either read fails. */
  private async readAccount(acct: number): Promise<{ positions: Row[]; orders: Row[] } | null> {
    const deadline = this.now() + ACCOUNT_READ_BUDGET_MS;
    const [ps, os] = await Promise.all([
      this.post<ApiEnvelope & { positions: Row[] }>("/api/Position/searchOpen", { accountId: acct }, deadline),
      this.post<ApiEnvelope & { orders: Row[] }>("/api/Order/searchOpen", { accountId: acct }, deadline),
    ]);
    if (!ps || !Array.isArray(ps.positions) || !os || !Array.isArray(os.orders)) return null;
    return { positions: ps.positions, orders: os.orders };
  }

  /**
   * account|contract -> time of the last order this server (either copy) sent
   * there since `sinceMs`, or null when the journal cannot be read (warned once).
   */
  private async ownOrders(sinceMs: number): Promise<Map<string, number> | null> {
    let entries;
    try {
      entries = await this.d.journal.readSince(sinceMs);
      this.journalWarned = false;
    } catch (e) {
      if (!this.journalWarned) this.warn(`reconcile: cannot read the journal (${e instanceof Error ? e.message : String(e)}); no checks until it can be read`);
      this.journalWarned = true;
      return null;
    }
    const last = new Map<string, number>();
    for (const e of entries) {
      if (!ORDER_KINDS.includes(e.kind) || !Number.isInteger(e.accountId) || typeof e.contractId !== "string") continue;
      const key = keyOf(e.accountId!, e.contractId);
      const t = Date.parse(e.ts);
      if (Number.isFinite(t)) last.set(key, Math.max(last.get(key) ?? -Infinity, t));
    }
    return last;
  }

  private async run(): Promise<CycleReport> {
    const { config } = this.d;
    const report = emptyReport();
    if (!config.tradingEnabled) return report;
    report.holdsLock = this.lock.hold();
    // The copy without the lock does not read: it only tries to take the lock each cycle.
    if (!report.holdsLock) return report;
    const graceMs = config.reconcileGraceSeconds * 1000;

    const t0 = this.now();
    // The trading day, or the last 24 h if longer: an overnight hold stays in scope after a restart.
    const own = await this.ownOrders(Math.min(tradingDayStart(new Date(t0)).getTime(), t0 - SCOPE_MIN_MS));
    if (!own) return report;
    report.accounts = [...new Set([...own.keys()].map((k) => Number(k.split("|")[0])))];
    for (const key of [...this.firstUncovered.keys()]) if (!own.has(key)) this.firstUncovered.delete(key);

    for (const acct of report.accounts) {
      const r = await this.readAccount(acct);
      // Never act on missing data: skip the account, keep what was seen before.
      if (!r) {
        report.unreadable.push(acct);
        continue;
      }
      await this.retryLegs(acct, r);
      const covers = coverage(r.positions, r.orders).filter((c) => own.has(keyOf(acct, c.contractId)));
      const uncovered = new Set(covers.filter((c) => !c.covered).map((c) => c.contractId));
      // A covered or flat contract ends its streak.
      for (const key of [...this.firstUncovered.keys()]) {
        const [a, cid] = key.split("|");
        if (Number(a) === acct && !uncovered.has(cid)) this.firstUncovered.delete(key);
      }

      for (const c of covers.filter((x) => !x.covered)) {
        report.uncovered.push({ accountId: acct, ...c });
        const key = keyOf(acct, c.contractId);
        const t = this.now();
        const first = this.firstUncovered.get(key);
        if (first === undefined) {
          this.firstUncovered.set(key, t);
          continue;
        }
        if (t - first < graceMs) continue;
        if (t - own.get(key)! < graceMs) continue;
        if ((this.backoffUntil.get(key) ?? -Infinity) > t) continue;
        if (!this.lock.mine()) continue;
        try {
          assertTradingAllowed(config, acct);
        } catch {
          continue;
        }
        // Re-read right before closing: skip if it is now covered or flat, or cannot be read.
        const again = await this.readAccount(acct);
        const fresh = again ? coverage(again.positions, again.orders).find((x) => x.contractId === c.contractId) : undefined;
        if (!again || !fresh || fresh.covered) {
          if (again) this.firstUncovered.delete(key);
          continue;
        }
        // A last look at the journal tail: an order sent on this pair within the grace (by either copy) wins.
        const graceStart = this.now() - graceMs;
        const recent = await this.d.journal.readSince(graceStart).catch(() => null);
        const orderedSince = (e: { kind: string; accountId?: number; contractId?: string; ts: string }) =>
          ORDER_KINDS.includes(e.kind as never) && e.accountId === acct && e.contractId === c.contractId && Date.parse(e.ts) > graceStart;
        if (!recent || recent.some(orderedSince)) continue;
        const fl = await this.flow.flatten(acct, c.contractId, this.now() + CALL_BUDGET_MS, CLOSE_CAP_MS);
        this.firstUncovered.delete(key);
        report.flattened.push({ accountId: acct, contractId: c.contractId, status: fl.status });
        await this.afterFlatten(acct, c.contractId, fl, fresh, t - first);
      }
    }
    return report;
  }

  /** Journal and warn about a flatten, and set the contract's backoff or leftover legs. */
  private async afterFlatten(acct: number, contractId: string, fl: FlattenResult, cover: Cover, uncoveredMs: number): Promise<void> {
    const key = keyOf(acct, contractId);
    const why = cover.direction === null ? "direction unknown and no one-sided stops" : `stops cover ${cover.stopSize} of ${cover.size}`;
    const what = `unprotected ${cover.direction ?? "unknown-direction"} position of ${cover.size} on ${contractId} (account ${acct}; ${why}; uncovered for ${Math.round(uncoveredMs / 1000)} s)`;
    let kind: "exit" | "note";
    let text: string;
    if (fl.status === "flat" || fl.status === "legs_left") {
      // Flat: the close worked. Leftover legs are retried on the next cycles, without a backoff.
      this.backoffUntil.delete(key);
      this.uncertainFails.delete(key);
      if (fl.status === "flat") {
        kind = "exit";
        text = `reconcile: flattened ${what} -> flat`;
      } else {
        kind = "note";
        text = `reconcile: flat; legs left: ${fl.remainingOrderIds?.join(", ") ?? "unknown (could not be read)"}; closed ${what}`;
        // Only legs the cancel step tried and failed on: an order first seen in the final read may be a new entry.
        const retry = fl.failedCancelOrderIds.filter((id) => fl.remainingOrderIds?.includes(id) ?? true);
        if (retry.length) this.legsLeft.set(key, retry);
      }
    } else {
      // A definitive refusal (an error code from the broker) waits 5 min; no reply or not flat in time steps 1, 2, 5 min.
      const refused = fl.close.success === false && fl.close.errorCode !== undefined;
      const n = refused ? 0 : (this.uncertainFails.get(key) ?? 0) + 1;
      if (!refused) this.uncertainFails.set(key, n);
      const wait = refused ? FAILED_FLATTEN_BACKOFF_MS : UNCERTAIN_BACKOFF_MS[Math.min(n, UNCERTAIN_BACKOFF_MS.length) - 1];
      this.backoffUntil.set(key, this.now() + wait);
      kind = "note";
      text = `reconcile: close failed: ${fl.status}; ${what}; next try in ${wait / 60_000} min`;
    }
    this.warn(text);
    await this.d.journal.add({ kind, text, accountId: acct, contractId, tags: ["reconcile", "unprotected"], data: { cover, flatten: fl } }).catch(() => {});
  }

  /** Cancel the legs a flatten left, while their contract stays flat; forget them once gone or if a position reopens. */
  private async retryLegs(acct: number, r: { positions: Row[]; orders: Row[] }): Promise<void> {
    for (const [key, ids] of [...this.legsLeft]) {
      const [a, contractId] = key.split("|");
      if (Number(a) !== acct) continue;
      const working = r.orders.filter((o) => o.contractId === contractId && ids.includes(o.id as number));
      if (positionOn(r.positions, contractId).size !== 0 || working.length === 0) {
        this.legsLeft.delete(key);
        continue;
      }
      if (!this.lock.mine()) continue;
      try {
        assertTradingAllowed(this.d.config, acct);
      } catch {
        continue;
      }
      const deadline = this.now() + ACCOUNT_READ_BUDGET_MS;
      await Promise.all(working.map((o) => this.post<ApiEnvelope>("/api/Order/cancel", { accountId: acct, orderId: o.id }, deadline)));
    }
  }
}
