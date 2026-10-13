import type { ApiEnvelope, PostOptions, ProjectXClient } from "./client.js";

export type SnapMode = "down" | "up" | "nearest";

/** Slack on the tick ratio so float noise (x.9999999999 ticks) never costs a whole tick. */
const EPSILON = 1e-9;

/**
 * Snap a price to the contract's tick grid: divide by the tick, floor/ceil/round
 * the ratio with a small epsilon, multiply back, and round to 10 decimals so the
 * result carries no float noise (TopstepX rejects off-grid prices).
 */
export function snapToTick(price: number, tick: number, mode: SnapMode): number {
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return price;
  const ratio = price / tick;
  const n = mode === "down" ? Math.floor(ratio + EPSILON) : mode === "up" ? Math.ceil(ratio - EPSILON) : Math.round(ratio);
  return Number((n * tick).toFixed(10));
}

export type PriceField = "limitPrice" | "stopPrice" | "trailPrice";

/**
 * Which way a price field rounds so it never moves toward the market or to a
 * worse fill. Stops (stopPrice, trailPrice): a sell stop rounds down, a buy stop
 * up. Limits: a buy rounds down (never pay more), a sell up. A stop-limit's
 * limitPrice rounds the same way as its stopPrice, so it never crosses the trigger.
 */
export function snapMode(field: PriceField, side: "buy" | "sell", stopLimit = false): SnapMode {
  if (field === "limitPrice" && !stopLimit) return side === "buy" ? "down" : "up";
  return side === "sell" ? "down" : "up";
}

export type Snapped = Partial<Record<PriceField, { from: number; to: number }>>;

/** Snap each given price field; returns the prices to send and what changed (empty when nothing did). */
export function snapPrices(
  prices: Partial<Record<PriceField, number | undefined>>,
  side: "buy" | "sell",
  tick: number | null,
  opts: { stopLimit?: boolean; fields?: readonly PriceField[] } = {},
): { prices: Partial<Record<PriceField, number | undefined>>; snapped: Snapped } {
  const out = { ...prices };
  const snapped: Snapped = {};
  if (tick === null) return { prices: out, snapped };
  for (const field of opts.fields ?? (["limitPrice", "stopPrice", "trailPrice"] as const)) {
    const from = prices[field];
    if (from === undefined) continue;
    const to = snapToTick(from, tick, snapMode(field, side, opts.stopLimit));
    if (to !== from) {
      out[field] = to;
      snapped[field] = { from, to };
    }
  }
  return { prices: out, snapped };
}

/**
 * Tick sizes from Contract/searchById, cached per contract for the process
 * lifetime. A failed lookup returns null and is not cached: the caller sends
 * the price unchanged and the broker decides.
 */
export class TickSizes {
  private readonly cache = new Map<string, number>();

  constructor(private readonly client: Pick<ProjectXClient, "post">) {}

  async get(contractId: string, opts: PostOptions = {}): Promise<number | null> {
    const hit = this.cache.get(contractId);
    if (hit !== undefined) return hit;
    try {
      const res = await this.client.post<ApiEnvelope & { contract?: { tickSize?: unknown } | null }>("/api/Contract/searchById", { contractId }, opts);
      const tick = Number(res.contract?.tickSize);
      if (!Number.isFinite(tick) || tick <= 0) return null;
      this.cache.set(contractId, tick);
      return tick;
    } catch {
      return null;
    }
  }
}
