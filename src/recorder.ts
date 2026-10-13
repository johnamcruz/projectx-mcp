/**
 * Recorder mode (`projectx-mcp --record-flow`): a long-running process that
 * serves no MCP. It runs the market-hub feeds for PROJECTX_FLOW_SYMBOLS (one
 * SignalR connection), re-resolves the active contracts at each trading-day
 * start, and writes complete minutes to PROJECTX_FLOW_DIR. One recorder per
 * directory: it holds `recorder.lock` there.
 */
import { join } from "node:path";
import type { ProjectXClient } from "./client.js";
import type { Config } from "./config.js";
import { FLOW_TICK_MS, FlowFeed, resolveActiveContract, type TickLookup } from "./flowfeed.js";
import { FlowWriter } from "./flowstore.js";
import type { FlowHub } from "./realtime.js";
import { ReconcileLock, type Timers } from "./reconcile.js";

/** The lock is taken over when its heartbeat is older than this (or its process is gone). */
export const RECORDER_STALE_MS = 6 * FLOW_TICK_MS;

export class RecorderError extends Error {}

/** Timers that keep the process alive: the recorder serves nothing else, so its timer must hold the event loop open. */
export const keepAliveTimers: Timers = {
  every: (ms, fn) => setInterval(fn, ms),
  cancel: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** The recorder's settings, or a clear error when one is missing. */
export function recorderSettings(config: Config): { symbols: string[]; dir: string } {
  const missing = [!config.flowSymbols.length && "PROJECTX_FLOW_SYMBOLS", !config.flowDir && "PROJECTX_FLOW_DIR"].filter(Boolean);
  if (missing.length) {
    throw new RecorderError(`--record-flow needs ${missing.join(" and ")} (e.g. PROJECTX_FLOW_SYMBOLS=MNQ,MES and PROJECTX_FLOW_DIR=~/.projectx-mcp/flow).`);
  }
  if (config.flowSymbols.length > config.flowMaxContracts) {
    throw new RecorderError(`PROJECTX_FLOW_SYMBOLS lists ${config.flowSymbols.length} symbols; at most ${config.flowMaxContracts} contracts can be subscribed.`);
  }
  return { symbols: config.flowSymbols, dir: config.flowDir! };
}

export interface RecorderDeps {
  config: Config;
  client: Pick<ProjectXClient, "post">;
  hub: FlowHub & { close?(): Promise<void> };
  ticks?: TickLookup;
  now?: () => number;
  warn?: (line: string) => void;
  timers?: Timers;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Called when the recorder stops on its own (it lost its lock). */
  onFatal?: (message: string) => void;
}

export class FlowRecorder {
  readonly lock: ReconcileLock;
  readonly feed: FlowFeed;
  readonly symbols: string[];
  readonly dir: string;
  private readonly warn: (line: string) => void;
  private readonly timers: Timers;
  private handle: unknown = null;
  private stopped = false;

  constructor(private readonly d: RecorderDeps) {
    const s = recorderSettings(d.config);
    this.symbols = s.symbols;
    this.dir = s.dir;
    const now = d.now ?? Date.now;
    this.warn = d.warn ?? ((line) => console.error(`[projectx-mcp] ${line}`));
    this.timers = d.timers ?? keepAliveTimers;
    this.lock = new ReconcileLock(join(this.dir, "recorder.lock"), RECORDER_STALE_MS, { now, pid: d.pid, isAlive: d.isAlive });
    const writer = new FlowWriter(this.dir, d.config.flowLargePrint, this.warn);
    this.feed = new FlowFeed({
      hub: d.hub,
      now,
      ticks: d.ticks,
      warn: this.warn,
      maxContracts: d.config.flowMaxContracts,
      resolve: (symbol) => resolveActiveContract(d.client, symbol),
      onMinute: (id, rec) => writer.write(id, rec),
      // The recorder keeps retrying its symbols' contracts; it never gives one up.
      dropFailedSubscribes: false,
      // The recorder drives the feed's maintenance itself, after each lock heartbeat.
      timers: { every: () => null, cancel: () => {} },
    });
    this.feed.setSymbols(this.symbols);
  }

  /** Take the lock (or fail), subscribe the symbols, and start the timer. */
  async start(): Promise<void> {
    if (!this.lock.hold()) {
      throw new RecorderError(`Another flow recorder is running: ${this.lock.path} is held. Stop it first (one recorder per PROJECTX_FLOW_DIR).`);
    }
    this.handle = this.timers.every(FLOW_TICK_MS, () => void this.cycle());
    await this.cycle();
  }

  /** Heartbeat the lock, then one feed pass (resubscribe, roll, write final minutes). */
  async cycle(): Promise<void> {
    if (this.stopped) return;
    if (!this.lock.hold()) {
      const msg = `flow recorder: lost ${this.lock.path} to another process; stopping`;
      this.warn(msg);
      await this.stop(false);
      this.d.onFatal?.(msg);
      return;
    }
    await this.feed.tick();
  }

  /** Stop the timer and the feeds, close the hub connection, release the lock. */
  async stop(finalize = true): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.handle !== null) this.timers.cancel(this.handle);
    this.handle = null;
    await this.feed.close({ finalize });
    await this.d.hub.close?.().catch(() => {});
    this.lock.release();
  }
}
