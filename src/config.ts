import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  username: string;
  apiKey: string;
  apiUrl: string;
  marketHubUrl: string;
  tradingEnabled: boolean;
  allowedAccountIds: number[];
  allowedSymbols: string[];
  maxOrderSize: number;
  maxPositionSize: number;
  maxDailyLoss: number;
  journalPath: string;
  /** Seconds between protection checks (only with trading enabled); 0 turns it off. */
  reconcileSeconds: number;
  /** An uncovered position must be seen on two checks at least this far apart before it is flattened. */
  reconcileGraceSeconds: number;
  /** Root symbols the flow recorder subscribes (recorder mode only). */
  flowSymbols: string[];
  /** Where the recorder writes complete minutes and MCP servers read them back; null = off. */
  flowDir: string | null;
  /** Default large-print threshold in contracts. */
  flowLargePrint: number;
  /** Most contracts with order-flow subscriptions per process. */
  flowMaxContracts: number;
  /** get_bars adds order flow when the call doesn't pass includeOrderFlow. */
  barsOrderFlow: boolean;
  /** get_bars' flow windows when the call doesn't pass flowWindows. */
  barsFlowWindows: number[];
}

/** get_bars' flowWindows limits: at most this many windows, each 1..BARS_FLOW_WINDOW_MAX bars. */
export const BARS_FLOW_WINDOWS_MAX = 5;
export const BARS_FLOW_WINDOW_MAX = 50;

type Env = Record<string, string | undefined>;

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  return n;
}

/** Trimmed and lowercased; empty is false; only "true" or "false" are accepted. */
function bool(env: Env, key: string): boolean {
  const raw = (env[key] ?? "").trim();
  const v = raw.toLowerCase();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  throw new Error(`${key} must be "true" or "false", got "${raw}"`);
}

/**
 * A comma list of get_bars flow windows. Unset or blank is none. Each item is trimmed, then checked in order:
 * digits only (an empty item is invalid), 1..BARS_FLOW_WINDOW_MAX, no duplicates, at most BARS_FLOW_WINDOWS_MAX.
 */
function flowWindows(env: Env, key: string): number[] {
  const raw = (env[key] ?? "").trim();
  if (!raw) return [];
  const items = raw.split(",").map((s) => s.trim());
  const bad = (item: string) => new Error(`${key} windows must be whole numbers from 1 to ${BARS_FLOW_WINDOW_MAX}, got "${item}"`);
  for (const item of items) if (!/^\d+$/.test(item)) throw bad(item);
  const values = items.map(Number);
  values.forEach((n, i) => {
    if (n < 1 || n > BARS_FLOW_WINDOW_MAX) throw bad(items[i]);
  });
  const seen = new Set<number>();
  for (const n of values) {
    if (seen.has(n)) throw new Error(`${key} has a duplicate window ${n}`);
    seen.add(n);
  }
  if (values.length > BARS_FLOW_WINDOWS_MAX) throw new Error(`${key} allows at most ${BARS_FLOW_WINDOWS_MAX} windows`);
  return values;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: Env = process.env): Config {
  const username = env.PROJECTX_USERNAME?.trim() ?? "";
  const apiKey = env.PROJECTX_API_KEY?.trim() ?? "";
  if (!username || !apiKey) {
    throw new Error(
      "PROJECTX_USERNAME and PROJECTX_API_KEY must be set (in the MCP client's env block or a .env file). " +
        "Generate a key at https://topstepx.com/settings?tab=api",
    );
  }
  const allowedAccountIds = list(env.PROJECTX_ALLOWED_ACCOUNT_IDS).map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`PROJECTX_ALLOWED_ACCOUNT_IDS contains a non-integer: "${s}"`);
    return n;
  });
  return {
    username,
    apiKey,
    apiUrl: (env.PROJECTX_API_URL?.trim() || "https://api.topstepx.com").replace(/\/+$/, ""),
    marketHubUrl: env.PROJECTX_MARKET_HUB_URL?.trim() || "https://rtc.topstepx.com/hubs/market",
    tradingEnabled: env.PROJECTX_TRADING_ENABLED?.trim().toLowerCase() === "true",
    allowedAccountIds,
    allowedSymbols: list(env.PROJECTX_ALLOWED_SYMBOLS).map((s) => s.toUpperCase()),
    maxOrderSize: num(env, "PROJECTX_MAX_ORDER_SIZE", 1),
    maxPositionSize: num(env, "PROJECTX_MAX_POSITION_SIZE", 2),
    maxDailyLoss: num(env, "PROJECTX_MAX_DAILY_LOSS", 500),
    journalPath: expandHome(env.PROJECTX_JOURNAL_PATH?.trim() || "~/.projectx-mcp/journal.jsonl"),
    reconcileSeconds: num(env, "PROJECTX_RECONCILE_SECONDS", 30),
    reconcileGraceSeconds: num(env, "PROJECTX_RECONCILE_GRACE_SECONDS", 15),
    flowSymbols: list(env.PROJECTX_FLOW_SYMBOLS).map((s) => s.toUpperCase()),
    flowDir: env.PROJECTX_FLOW_DIR?.trim() ? expandHome(env.PROJECTX_FLOW_DIR.trim()) : null,
    flowLargePrint: num(env, "PROJECTX_FLOW_LARGE_PRINT", 10),
    flowMaxContracts: Math.max(1, Math.floor(num(env, "PROJECTX_FLOW_MAX_CONTRACTS", 6))),
    barsOrderFlow: bool(env, "PROJECTX_BARS_ORDER_FLOW"),
    barsFlowWindows: flowWindows(env, "PROJECTX_BARS_FLOW_WINDOWS"),
  };
}

/** Smallest reconcile interval; a smaller non-zero setting is raised to this. */
export const MIN_RECONCILE_SECONDS = 5;

/** The reconcile interval in effect: 0 when off (trading disabled or set to 0), else at least MIN_RECONCILE_SECONDS. */
export function reconcileInterval(c: Config): number {
  if (!c.tradingEnabled || c.reconcileSeconds <= 0) return 0;
  return Math.max(MIN_RECONCILE_SECONDS, c.reconcileSeconds);
}

/** Config safe to show the model: no credentials. */
export function publicConfig(c: Config) {
  return {
    apiUrl: c.apiUrl,
    username: c.username,
    tradingEnabled: c.tradingEnabled,
    allowedAccountIds: c.allowedAccountIds.length ? c.allowedAccountIds : "any",
    allowedSymbols: c.allowedSymbols.length ? c.allowedSymbols : "any",
    maxOrderSize: c.maxOrderSize,
    maxPositionSize: c.maxPositionSize,
    maxDailyLoss: c.maxDailyLoss || "off",
    journalPath: c.journalPath,
    // The protection check runs only with trading enabled.
    reconcileSeconds: reconcileInterval(c) || "off",
    reconcileGraceSeconds: c.reconcileGraceSeconds,
    flow: {
      largePrint: c.flowLargePrint,
      maxContracts: c.flowMaxContracts,
      recordedBackfill: c.flowDir ? "on" : "off",
      // get_bars' defaults when a call doesn't pass includeOrderFlow / flowWindows.
      barsOrderFlow: c.barsOrderFlow,
      barsFlowWindows: c.barsFlowWindows,
    },
  };
}
