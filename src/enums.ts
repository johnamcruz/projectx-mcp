// Enum values from https://gateway.docs.projectx.com/docs/realtime/ (Enum Definitions).

export const ORDER_TYPES = {
  limit: 1,
  market: 2,
  stop_limit: 3,
  stop: 4,
  trailing_stop: 5,
  join_bid: 6,
  join_ask: 7,
} as const;
export type OrderTypeName = keyof typeof ORDER_TYPES;
/** Types the Order/place endpoint accepts (StopLimit is not listed there). */
export const PLACEABLE_ORDER_TYPES = ["limit", "market", "stop", "trailing_stop", "join_bid", "join_ask"] as const;

export const SIDES = { buy: 0, sell: 1 } as const;
export type SideName = keyof typeof SIDES;

export const BAR_UNITS = { second: 1, minute: 2, hour: 3, day: 4, week: 5, month: 6 } as const;
export type BarUnitName = keyof typeof BAR_UNITS;

const ORDER_STATUS = ["none", "open", "filled", "cancelled", "expired", "rejected", "pending"];
const POSITION_TYPE = ["undefined", "long", "short"];
const ORDER_TYPE_NAMES = Object.fromEntries(Object.entries(ORDER_TYPES).map(([k, v]) => [v, k])) as Record<number, string>;
const SIDE_NAMES = ["buy", "sell"];

const name = (arr: string[] | Record<number, string>, v: unknown) =>
  typeof v === "number" ? ((arr as Record<number, string>)[v] ?? `unknown(${v})`) : v;

/** Add human-readable names next to the numeric enum fields the API returns. */
export function decorateOrder<T extends Record<string, unknown>>(o: T) {
  return { ...o, statusName: name(ORDER_STATUS, o.status), typeName: name(ORDER_TYPE_NAMES, o.type), sideName: name(SIDE_NAMES, o.side) };
}

export function decoratePosition<T extends Record<string, unknown>>(p: T) {
  return { ...p, direction: name(POSITION_TYPE, p.type) };
}

export function decorateTrade<T extends Record<string, unknown>>(t: T) {
  return { ...t, sideName: name(SIDE_NAMES, t.side), halfTurn: t.profitAndLoss === null };
}
