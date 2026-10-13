import type { Config } from "./config.js";

export class RiskError extends Error {}

/** "CON.F.US.MNQ.U25" -> "MNQ". Falls back to the whole id if the shape is unexpected. */
export function symbolRoot(contractId: string): string {
  const parts = contractId.split(".");
  return (parts.length >= 5 ? parts[3] : contractId).toUpperCase();
}

/**
 * Start of the CME trading day containing `now`: the most recent 17:00
 * America/Chicago. Topstep daily loss limits reset on this boundary.
 */
export function tradingDayStart(now: Date = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year), m = Number(parts.month) - 1, d = Number(parts.day), h = Number(parts.hour);
  const dayOffset = h >= 17 ? 0 : -1;
  // 17:00 Chicago on that calendar date, expressed as if it were UTC, then shifted by Chicago's offset.
  const naive = Date.UTC(y, m, d + dayOffset, 17);
  const offsetAt = (t: number) => {
    const local = new Date(new Date(t).toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const utc = new Date(new Date(t).toLocaleString("en-US", { timeZone: "UTC" }));
    return local.getTime() - utc.getTime();
  };
  let result = naive - offsetAt(naive);
  result = naive - offsetAt(result);
  return new Date(result);
}

export interface TradeLike {
  profitAndLoss: number | null;
  fees: number | null;
  voided: boolean;
}

/** Realized P&L net of fees, ignoring voided trades. */
export function realizedNet(trades: TradeLike[]): number {
  return trades.filter((t) => !t.voided).reduce((sum, t) => sum + (t.profitAndLoss ?? 0) - (t.fees ?? 0), 0);
}

export function assertTradingAllowed(config: Config, accountId: number): void {
  if (!config.tradingEnabled) {
    throw new RiskError(
      "Trading is disabled on this MCP server (PROJECTX_TRADING_ENABLED is not true). Read-only tools still work.",
    );
  }
  if (config.allowedAccountIds.length && !config.allowedAccountIds.includes(accountId)) {
    throw new RiskError(`Account ${accountId} is not in PROJECTX_ALLOWED_ACCOUNT_IDS (${config.allowedAccountIds.join(", ")}).`);
  }
}

export function assertSymbolAllowed(config: Config, contractId: string): void {
  const root = symbolRoot(contractId);
  if (config.allowedSymbols.length && !config.allowedSymbols.includes(root)) {
    throw new RiskError(`Symbol ${root} is not in PROJECTX_ALLOWED_SYMBOLS (${config.allowedSymbols.join(", ")}).`);
  }
}

export function assertOrderSize(config: Config, size: number): void {
  if (size > config.maxOrderSize) {
    throw new RiskError(`Order size ${size} exceeds PROJECTX_MAX_ORDER_SIZE (${config.maxOrderSize}).`);
  }
}

export interface ExposureInput {
  /** Current net position: +long / -short; null when a position is open but its direction is unknown. */
  currentNet: number | null;
  /** Total open size on the contract regardless of direction (used when currentNet is null). */
  currentSize?: number;
  /** Sum of same-side resting entry orders (limit/join) on this contract. */
  pendingSameSide: number;
  side: "buy" | "sell";
  size: number;
}

/** Worst-case net position if this order and resting same-side entries all fill (an unknown direction counts as the order's side). */
export function projectedNet({ currentNet, currentSize = 0, pendingSameSide, side, size }: ExposureInput): number {
  const sign = side === "buy" ? 1 : -1;
  return (currentNet ?? sign * currentSize) + sign * (pendingSameSide + size);
}

/**
 * True only when the order is on the opposite side of a known, non-zero net
 * position and no larger than it: it can only shrink the position.
 */
export function reducesPosition({ currentNet, side, size }: ExposureInput): boolean {
  if (currentNet === null || currentNet === 0) return false;
  return Math.sign(currentNet) === (side === "buy" ? -1 : 1) && size <= Math.abs(currentNet);
}

/** True when the order opens, adds to, or reverses a position (anything that is not purely reducing). */
export function increasesExposure(input: ExposureInput): boolean {
  return !reducesPosition(input);
}

export function assertPositionLimit(config: Config, input: ExposureInput): void {
  const projected = projectedNet(input);
  if (increasesExposure(input) && Math.abs(projected) > config.maxPositionSize) {
    throw new RiskError(
      `Order would take net position to ${projected} (current ${input.currentNet ?? `${input.currentSize}, direction unknown`}, resting same-side entries ${input.pendingSameSide}); ` +
        `PROJECTX_MAX_POSITION_SIZE is ${config.maxPositionSize}.`,
    );
  }
}

export function assertDailyLoss(config: Config, realized: number): void {
  if (config.maxDailyLoss > 0 && realized <= -config.maxDailyLoss) {
    throw new RiskError(
      `Daily loss limit reached: realized net P&L today is ${realized.toFixed(2)} (limit -${config.maxDailyLoss}). ` +
        "Only risk-reducing orders are allowed until the next trading day (17:00 America/Chicago).",
    );
  }
}
