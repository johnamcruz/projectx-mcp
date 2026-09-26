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
}

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
  };
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
  };
}
