import { type ApiEnvelope, type PostOptions, type ProjectXClient } from "./client.js";
import { ORDER_TYPES, SIDES } from "./enums.js";
import type { Journal } from "./journal.js";

/** Smallest bracket distance place_order accepts, in ticks. */
export const MIN_BRACKET_TICKS = 4;
/** place_order and close_position (and every other order tool) must answer within this; the caller times out at 15 s. */
export const CALL_BUDGET_MS = 9_500;
/** The flatten's share of a call: it runs in the last FLATTEN_RESERVE_MS before the deadline. */
export const FLATTEN_RESERVE_MS = 3_400;
/** Before the flatten: time to cancel an unconfirmed entry and read the position. */
export const SETTLE_MS = 600;
/** The fill check gets at least this long: the entry must be answered this long before the settle step. */
export const FILL_WINDOW_MS = 2_000;
/** The entry (and a lookup by tag if its reply is lost) must finish this long before the deadline. */
export const PLACE_BY_MS = FLATTEN_RESERVE_MS + SETTLE_MS + FILL_WINDOW_MS;
/** Inside a flatten, each step must end this long before the deadline. */
const CLOSE_BY_MS = 2_400;
const FLAT_BY_MS = 1_800;
const LEGS_BY_MS = 1_200;
const CANCEL_BY_MS = 600;
/** Polling step while waiting for fills, stops, and a flat position. */
export const POLL_MS = 300;
/** How long after the fill an accepted bracket's stop leg may take to show up. */
export const STOP_CHECK_MS = 3_000;

export interface FlowDeps {
  client: Pick<ProjectXClient, "post">;
  journal: Journal;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

type Row = Record<string, unknown>;

const FILLED = 2;
const ENDED_WITHOUT_FILL = [3, 4, 5]; // cancelled, expired, rejected
const STATUS_NAMES: Record<number, string> = { 3: "cancelled", 4: "expired", 5: "rejected" };
const STOP_TYPES: number[] = [ORDER_TYPES.stop, ORDER_TYPES.trailing_stop];

/** Signed bracket ticks the API expects: long stop below (-), target above (+); short the reverse. */
export function signedBrackets(side: "buy" | "sell", stopTicks: number | undefined, targetTicks: number | undefined) {
  const s = side === "buy" ? 1 : -1;
  return {
    stop: stopTicks === undefined ? undefined : -s * Math.abs(stopTicks),
    target: targetTicks === undefined ? undefined : s * Math.abs(targetTicks),
  };
}

export interface PositionState {
  /** +long / -short; null when an open row has no known direction. */
  net: number | null;
  /** Total open size on the contract, whatever the direction. Flat means 0. */
  size: number;
  averagePrice: number | null;
}

/** The position on one contract. Flatness is decided by size alone, so a row without a known direction never reads as flat. */
export function positionOn(positions: Row[], contractId: string): PositionState {
  const rows = positions.filter((p) => p.contractId === contractId && Math.abs(Number(p.size) || 0) > 0);
  const size = rows.reduce((n, p) => n + Math.abs(Number(p.size)), 0);
  const known = rows.every((p) => p.type === 1 || p.type === 2);
  const net = known ? rows.reduce((n, p) => n + (p.type === 1 ? 1 : -1) * Math.abs(Number(p.size)), 0) : null;
  return { net, size, averagePrice: (rows[0]?.averagePrice as number | undefined) ?? null };
}

export type FlatStatus = "flat" | "still_open" | "legs_left";
export interface FlattenResult {
  status: FlatStatus;
  close: { success: boolean; errorCode?: number; errorMessage?: string | null };
  /** Net position at the end (null when it could not be read or its direction is unknown). */
  positionNet: number | null;
  /** Total open size at the end (null when it could not be read). */
  positionSize: number | null;
  cancelledOrderIds: number[];
  /** Working orders still on the contract (null when they could not be read). */
  remainingOrderIds: number[] | null;
}

export type ProtectionStatus = "protected" | "flattened_stop_unconfirmed" | "pending_fill" | "not_filled" | "unknown";
export interface Protection {
  status: ProtectionStatus;
  stopOrderId: number | null;
  filledSize: number | null;
  fillPrice: number | null;
  targetPlaced: boolean;
  message: string;
  flatten?: FlattenResult;
}

export function protectionFlow(d: FlowDeps) {
  const { client, journal, now, sleep } = d;

  /** One request bounded by `end`; null on any failure or when no time is left. */
  async function tryPost<T extends ApiEnvelope>(path: string, body: unknown, capMs: number, end: number, allowFailure = false): Promise<T | null> {
    const timeoutMs = Math.min(capMs, end - now());
    if (timeoutMs < 50) return null;
    const opts: PostOptions = { timeoutMs, deadline: end, allowFailure };
    try {
      return await client.post<T>(path, body, opts);
    } catch {
      return null;
    }
  }

  const positions = async (acct: number, cap: number, end: number) =>
    (await tryPost<ApiEnvelope & { positions: Row[] }>("/api/Position/searchOpen", { accountId: acct }, cap, end))?.positions ?? null;
  const ordersOn = async (acct: number, contractId: string, cap: number, end: number) =>
    (await tryPost<ApiEnvelope & { orders: Row[] }>("/api/Order/searchOpen", { accountId: acct }, cap, end))?.orders.filter(
      (o) => o.contractId === contractId,
    ) ?? null;

  const note = (text: string, acct: number, contractId: string, data: unknown, orderId?: number) =>
    journal.add({ kind: "note", text, accountId: acct, contractId, orderId, tags: ["protection"], data }).catch(() => {});

  /** Sleep one poll step if it still leaves time before `end`. */
  async function pollStep(end: number): Promise<boolean> {
    if (now() + POLL_MS >= end) return false;
    await sleep(POLL_MS);
    return true;
  }

  /**
   * Close the contract, cancel its working orders once it is flat, and verify.
   * Legs are cancelled only after the position is seen flat (total size 0), so
   * an open position never loses its stop. Finishes by `deadline`.
   */
  async function flatten(acct: number, contractId: string, deadline: number, closeCapMs: number): Promise<FlattenResult> {
    const closeRes = await tryPost<ApiEnvelope>("/api/Position/closeContract", { accountId: acct, contractId }, closeCapMs, deadline - CLOSE_BY_MS, true);
    const close = closeRes ? { success: closeRes.success, errorCode: closeRes.errorCode, errorMessage: closeRes.errorMessage } : { success: false, errorMessage: "no reply (timeout or network error)" };

    let st: PositionState | null = null;
    for (;;) {
      const p = await positions(acct, 600, deadline - FLAT_BY_MS);
      if (p) st = positionOn(p, contractId);
      if (st?.size === 0 || !(await pollStep(deadline - FLAT_BY_MS))) break;
    }
    if (!st || st.size !== 0) {
      return { status: "still_open", close, positionNet: st?.net ?? null, positionSize: st?.size ?? null, cancelledOrderIds: [], remainingOrderIds: null };
    }

    const legs = (await ordersOn(acct, contractId, 600, deadline - LEGS_BY_MS)) ?? [];
    const cancelled = await Promise.all(
      legs.map(async (o) => {
        const r = await tryPost<ApiEnvelope>("/api/Order/cancel", { accountId: acct, orderId: o.id }, 600, deadline - CANCEL_BY_MS, true);
        return r?.success ? (o.id as number) : null;
      }),
    );
    const [p, left] = await Promise.all([positions(acct, 600, deadline), ordersOn(acct, contractId, 600, deadline)]);
    const fin = p ? positionOn(p, contractId) : null;
    const remaining = left ? left.map((o) => o.id as number) : null;
    const status: FlatStatus = fin?.size !== 0 ? "still_open" : remaining === null || remaining.length ? "legs_left" : "flat";
    return { status, close, positionNet: fin?.net ?? null, positionSize: fin?.size ?? null, cancelledOrderIds: cancelled.filter((x): x is number => x !== null), remainingOrderIds: remaining };
  }

  interface EntryInput {
    accountId: number;
    contractId: string;
    side: "buy" | "sell";
    orderId: number;
    /** The position on the contract before the entry. */
    before: PositionState;
    targetRequested: boolean;
    /** Absolute time by which the whole place_order call must answer. */
    deadline: number;
  }

  /**
   * After an accepted bracketed market entry: wait for the fill, then confirm
   * a stop leg covers the new position, else flatten. It never places a stop
   * of its own: one could double up with a bracket leg that shows up late.
   */
  async function protectEntry(e: EntryInput): Promise<Protection> {
    const { accountId: acct, contractId, side, before } = e;
    const sign = side === "buy" ? 1 : -1;
    const flattenAt = e.deadline - FLATTEN_RESERVE_MS;
    const fillBy = flattenAt - SETTLE_MS;
    const searchFrom = new Date(now() - 5 * 60_000).toISOString();
    const base = { stopOrderId: null, filledSize: null as number | null, fillPrice: null as number | null, targetPlaced: e.targetRequested };

    let order: Row | null = null;
    let st: PositionState | null = null;
    const read = async (cap: number, end: number) => {
      const [os, ps] = await Promise.all([
        tryPost<ApiEnvelope & { orders: Row[] }>("/api/Order/search", { accountId: acct, startTimestamp: searchFrom, endTimestamp: null }, cap, end),
        positions(acct, cap, end),
      ]);
      order = os?.orders.find((o) => o.id === e.orderId) ?? order;
      if (ps) st = positionOn(ps, contractId);
    };
    /** The position moved the entry's way (true/false), or null when that cannot be told. */
    const moved = (s: PositionState | null): boolean | null => {
      if (!s) return null;
      if (before.net !== null && s.net !== null) return (s.net - before.net) * sign > 0;
      // Typeless: a size change is a fill; an unchanged size with an entry that ended empty is no fill.
      return s.size !== before.size ? true : endedEmpty(order) ? false : null;
    };
    const fillVolume = (o: Row | null) => Number(o?.fillVolume) || 0;
    const filled = (o: Row | null) => o !== null && (o.status === FILLED || (ENDED_WITHOUT_FILL.includes(o.status as number) && fillVolume(o) > 0));
    const endedEmpty = (o: Row | null) => o !== null && ENDED_WITHOUT_FILL.includes(o.status as number) && fillVolume(o) === 0;
    const fillOf = () => {
      const delta = before.net !== null && st?.net != null ? (st.net - before.net) * sign : null;
      return {
        filledSize: filled(order) ? fillVolume(order) || (order!.size as number) : delta !== null && delta > 0 ? delta : null,
        fillPrice: (order?.filledPrice as number | undefined) ?? st?.averagePrice ?? null,
      };
    };

    const giveUp = async (why: string): Promise<Protection> => {
      const fill = fillOf();
      const fl = await flatten(acct, contractId, e.deadline, 1_000);
      await note(`flatten after unconfirmed stop: ${why} -> ${fl.status}`, acct, contractId, fl, e.orderId);
      if (fl.status === "flat") {
        return { ...base, ...fill, status: "flattened_stop_unconfirmed", targetPlaced: false, flatten: fl, message: `The entry ${why}, so the server closed the position and cancelled its orders. The account is flat on ${contractId}.` };
      }
      return {
        ...base, ...fill, status: "unknown", targetPlaced: false, flatten: fl,
        message:
          `UNPROTECTED POSITION MAY BE OPEN on ${contractId}: the entry ${why}, and closing it could not be confirmed (${fl.status}). ` +
          "Call close_position for this contract now, then check list_open_positions and list_open_orders and protect or close what is left. Never re-send the entry.",
      };
    };

    // 1. Wait for the fill.
    for (;;) {
      await read(1_000, fillBy);
      if (filled(order) || (order === null && moved(st) === true)) break;
      if (endedEmpty(order) && moved(st) === false) return { ...base, status: "not_filled", targetPlaced: false, message: `The broker ended the market entry without a fill (${STATUS_NAMES[order!.status as number] ?? order!.status}); this entry opened nothing, and any earlier position is unchanged.` };
      if (!(await pollStep(fillBy))) break;
    }

    // 2. Not confirmed filled in time: cancel the entry, then see what is open.
    if (!filled(order) && !(order === null && moved(st) === true)) {
      const c = await tryPost<ApiEnvelope>("/api/Order/cancel", { accountId: acct, orderId: e.orderId }, 300, flattenAt - 300, true);
      await note(`fill not confirmed in time: cancel entry ${e.orderId}: ${c?.success ? "ok" : "failed"}`, acct, contractId, c, e.orderId);
      await read(300, flattenAt);
      if (!filled(order) && endedEmpty(order) && moved(st) === false) {
        return { ...base, status: "not_filled", targetPlaced: false, message: "The market entry was not filled within the check window, so the server cancelled it; this entry opened nothing, and any earlier position is unchanged." };
      }
      return giveUp("was not confirmed filled in time");
    }

    // 3. Confirm a stop leg covers the new position, re-reading the position each time (a late fill must be covered too).
    const stopBy = Math.min(now() + STOP_CHECK_MS, flattenAt);
    for (;;) {
      const [os, ps] = await Promise.all([ordersOn(acct, contractId, 800, flattenAt), positions(acct, 800, flattenAt)]);
      if (ps) st = positionOn(ps, contractId);
      const s = st as PositionState | null;
      if (os && s && s.size > 0) {
        // Cover the new net's side; with an unknown direction, the side opposite the entry and the whole size.
        const coverSide = s.net !== null && s.net !== 0 ? (s.net > 0 ? SIDES.sell : SIDES.buy) : side === "buy" ? SIDES.sell : SIDES.buy;
        const required = s.net !== null && s.net !== 0 ? Math.abs(s.net) : s.size;
        const stops = os.filter((o) => STOP_TYPES.includes(o.type as number) && o.side === coverSide);
        if (stops.reduce((n, o) => n + (Number(o.size) || 0), 0) >= required) {
          return { ...base, ...fillOf(), status: "protected", stopOrderId: stops[0].id as number, message: "The entry filled and its stop is working." };
        }
      }
      if (!(await pollStep(stopBy))) break;
    }
    return giveUp("filled but its stop leg was not confirmed in time");
  }

  return { flatten, protectEntry };
}
