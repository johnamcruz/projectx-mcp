import { describe, expect, it } from "vitest";
import { OrderOutcomeUnknownError, ProjectXError, type PostOptions } from "../src/client.js";
import { OK, fakeClock, setup } from "./helpers.js";

const order = { accountId: 1, contractId: "CON.F.US.MNQ.Z25", side: "buy", type: "market", size: 1, rationale: "breakout above ORH, stop below VWAP, 2R target" };

describe("tool registry", () => {
  it("exposes every tool with read/write annotations", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        "cancel_order", "close_position", "get_account_snapshot", "get_bars", "get_contract", "get_performance", "get_quote",
        "get_server_config", "journal_add", "journal_read", "list_accounts", "list_available_contracts", "list_open_orders",
        "list_open_positions", "modify_order", "partial_close_position", "place_order", "search_contracts", "search_orders", "search_trades",
      ].sort(),
    );
    for (const w of ["place_order", "modify_order", "cancel_order", "close_position", "partial_close_position"]) {
      expect(byName[w].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(byName.get_bars.annotations?.readOnlyHint).toBe(true);
  });

  it("serves the guide resource and the session prompt", async () => {
    const { client } = await setup();
    const res = await client.readResource({ uri: "projectx://guide" });
    expect((res.contents[0] as { text: string }).text.length).toBeGreaterThan(100);
    const prompt = await client.getPrompt({ name: "trading_session", arguments: { focus: "MNQ" } });
    expect(JSON.stringify(prompt.messages)).toMatch(/focused on MNQ/);
  });

  it("sends server instructions on initialize", async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toMatch(/projectx:\/\/guide/);
  });
});

describe("read tools", () => {
  it("get_server_config hides credentials", async () => {
    const { call } = await setup();
    const { text, data } = await call("get_server_config");
    expect(text).not.toContain("secret-key");
    expect(data).toMatchObject({ tradingEnabled: true, maxOrderSize: 1, username: "trader" });
  });

  it("list_accounts flags which accounts the MCP may trade", async () => {
    const { call, api } = await setup({ env: { PROJECTX_ALLOWED_ACCOUNT_IDS: "2" } });
    const { data } = await call("list_accounts");
    expect(api.bodiesFor("/api/Account/search")[0]).toEqual({ onlyActiveAccounts: true });
    expect(data.map((a: any) => a.mcpTradingAllowed)).toEqual([false, true]);
  });

  it("get_account_snapshot combines balance, positions, orders, and today's P&L", async () => {
    const { call, api } = await setup({
      env: { PROJECTX_MAX_DAILY_LOSS: "500" },
      routes: {
        "/api/Position/searchOpen": () => ({ ...OK, positions: [{ contractId: "X", type: 2, size: 1 }] }),
        "/api/Order/searchOpen": () => ({ ...OK, orders: [{ id: 5, status: 1, type: 4, side: 0 }] }),
        "/api/Trade/search": () => ({ ...OK, trades: [{ contractId: "X", profitAndLoss: -100, fees: 2, voided: false }] }),
      },
    });
    const { data } = await call("get_account_snapshot", { accountId: 1 });
    expect(data.account.name).toBe("ACC1");
    expect(data.positions[0].direction).toBe("short");
    expect(data.openOrders[0]).toMatchObject({ statusName: "open", typeName: "stop", sideName: "buy" });
    expect(data.today).toMatchObject({ realizedNetPnL: -102, remainingBeforeLimit: 398, losses: 1 });
    expect(api.bodiesFor("/api/Trade/search")[0].startTimestamp).toMatch(/T2[23]:00:00/);
  });

  it("contract lookups pass through", async () => {
    const { call, api } = await setup({
      routes: {
        "/api/Contract/search": () => ({ ...OK, contracts: [{ id: "A" }] }),
        "/api/Contract/searchById": () => ({ ...OK, contract: { id: "B" } }),
        "/api/Contract/available": () => ({ ...OK, contracts: [{ id: "C" }] }),
      },
    });
    expect((await call("search_contracts", { searchText: "MNQ" })).data).toEqual([{ id: "A" }]);
    expect(api.bodiesFor("/api/Contract/search")[0]).toEqual({ searchText: "MNQ", live: false });
    expect((await call("get_contract", { contractId: "B" })).data).toEqual({ id: "B" });
    expect((await call("list_available_contracts")).data).toEqual([{ id: "C" }]);
  });

  it("get_bars maps units, defaults the window, and sorts oldest first", async () => {
    const { call, api } = await setup({
      routes: {
        "/api/History/retrieveBars": () => ({ ...OK, bars: [{ t: "2025-01-01T02:00:00Z" }, { t: "2025-01-01T01:00:00Z" }] }),
      },
    });
    const { data } = await call("get_bars", { contractId: "X", unit: "hour", unitNumber: 1, limit: 2 });
    expect(data.bars.map((b: any) => b.t)).toEqual(["2025-01-01T01:00:00Z", "2025-01-01T02:00:00Z"]);
    expect(data.barSize).toBe("1 hour");
    const body = api.bodiesFor("/api/History/retrieveBars")[0];
    expect(body).toMatchObject({ contractId: "X", unit: 3, unitNumber: 1, limit: 2, live: false, includePartialBar: false });
    expect(Date.parse(body.endTime) - Date.parse(body.startTime)).toBe(2 * 36e5 * 2 + 4 * 864e5);

    await call("get_bars", { contractId: "X", startTime: "2025-01-01T00:00:00Z", endTime: "2025-01-02T00:00:00Z" });
    expect(api.bodiesFor("/api/History/retrieveBars")[1]).toMatchObject({ startTime: "2025-01-01T00:00:00.000Z", unit: 2, unitNumber: 5 });
  });

  it("get_quote returns the cached quote or a helpful null", async () => {
    const hit = await setup({ quote: { getQuote: async () => ({ quote: { lastPrice: 100 }, ageMs: 5 }), close: async () => {} } });
    expect((await hit.call("get_quote", { contractId: "X" })).data).toEqual({ contractId: "X", ageMs: 5, quote: { lastPrice: 100 } });
    const miss = await setup();
    expect((await miss.call("get_quote", { contractId: "X" })).data).toMatchObject({ quote: null, note: expect.stringMatching(/closed/) });
  });

  it("order, position, and trade searches decorate enums", async () => {
    const { call, api } = await setup({
      routes: {
        "/api/Order/search": () => ({ ...OK, orders: [{ id: 1, status: 2, type: 2, side: 1 }] }),
        "/api/Order/searchOpen": () => ({ ...OK, orders: [{ id: 2, status: 1, type: 1, side: 0 }] }),
        "/api/Position/searchOpen": () => ({ ...OK, positions: [{ id: 3, type: 1, size: 2 }] }),
        "/api/Trade/search": () => ({ ...OK, trades: [{ id: 4, side: 0, profitAndLoss: null }] }),
      },
    });
    expect((await call("search_orders", { accountId: 1, startTimestamp: "2025-01-01T00:00:00Z" })).data[0]).toMatchObject({ statusName: "filled", typeName: "market", sideName: "sell" });
    expect(api.bodiesFor("/api/Order/search")[0].endTimestamp).toBeNull();
    expect((await call("list_open_orders", { accountId: 1 })).data[0]).toMatchObject({ statusName: "open", typeName: "limit" });
    expect((await call("list_open_positions", { accountId: 1 })).data[0].direction).toBe("long");
    expect((await call("search_trades", { accountId: 1 })).data[0]).toMatchObject({ sideName: "buy", halfTurn: true });
  });

  it("get_performance summarizes a window", async () => {
    const { call, api } = await setup({
      routes: { "/api/Trade/search": () => ({ ...OK, trades: [{ contractId: "X", profitAndLoss: 50, fees: 1, voided: false }] }) },
    });
    const { data } = await call("get_performance", { accountId: 1, startTimestamp: "2025-01-01T00:00:00Z", endTimestamp: "2025-02-01T00:00:00Z" });
    expect(data.overall).toMatchObject({ wins: 1, netPnL: 49 });
    expect(data.byContract.X.wins).toBe(1);
    expect(api.bodiesFor("/api/Trade/search")[0]).toMatchObject({ startTimestamp: "2025-01-01T00:00:00Z", endTimestamp: "2025-02-01T00:00:00Z" });
  });

  it("surfaces API failures as tool errors", async () => {
    const { call } = await setup({ routes: { "/api/Contract/searchById": () => ({ success: false, errorCode: 1, errorMessage: null }) } });
    const res = await call("get_contract", { contractId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/errorCode 1/);
  });
});

describe("place_order", () => {
  it("maps names to API enums, sends brackets, and journals the rationale", async () => {
    const { call, api, journal } = await setup();
    const res = await call("place_order", {
      ...order,
      type: "limit",
      limitPrice: 21000.25,
      stopLossBracket: { ticks: 20, type: "stop" },
      takeProfitBracket: { ticks: 40, type: "limit" },
    });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ orderId: 42, success: true, errorName: "Success" });
    expect(api.bodiesFor("/api/Order/place")[0]).toEqual({
      accountId: 1, contractId: "CON.F.US.MNQ.Z25", type: 1, side: 0, size: 1, limitPrice: 21000.25, stopPrice: null,
      trailPrice: null, customTag: expect.stringMatching(/^pxm-/), stopLossBracket: { ticks: -20, type: 4 }, takeProfitBracket: { ticks: 40, type: 1 },
    });
    expect(res.data.protection).toMatchObject({ status: "pending_fill", targetPlaced: true });
    const [entry] = await journal.read({ kind: "order_placed" });
    expect(entry).toMatchObject({ text: order.rationale, orderId: 42, contractId: "CON.F.US.MNQ.Z25" });
  });

  it("reports API rejections with the error name", async () => {
    const { call } = await setup({
      routes: { "/api/Order/place": () => ({ orderId: 9, success: false, errorCode: 5, errorMessage: null }) },
    });
    const res = await call("place_order", order);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ errorName: "OutsideTradingHours", orderId: 9 });
  });

  it.each([
    [{ type: "limit" }, /limitPrice/],
    [{ type: "stop" }, /stopPrice/],
    [{ type: "trailing_stop" }, /trailPrice/],
  ])("requires the price for %o", async (patch, msg) => {
    const { call, api } = await setup();
    const res = await call("place_order", { ...order, ...patch });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(msg);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(0);
  });

  it("is refused and journaled when trading is disabled", async () => {
    const { call, api, journal } = await setup({ env: { PROJECTX_TRADING_ENABLED: "false" } });
    const res = await call("place_order", order);
    expect(res.text).toMatch(/Blocked by risk guardrail: Trading is disabled/);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(0);
    expect((await journal.read({ kind: "order_blocked" }))[0].text).toContain(order.rationale);
  });

  it("enforces symbol and order-size limits", async () => {
    const { call } = await setup({ env: { PROJECTX_ALLOWED_SYMBOLS: "MES", PROJECTX_MAX_ORDER_SIZE: "1" } });
    expect((await call("place_order", order)).text).toMatch(/MNQ is not in/);
    expect((await call("place_order", { ...order, contractId: "CON.F.US.MES.Z25", size: 2 })).text).toMatch(/exceeds PROJECTX_MAX_ORDER_SIZE/);
  });

  it("counts the open position and resting same-side entries against the position limit", async () => {
    const { call, api } = await setup({
      env: { PROJECTX_MAX_POSITION_SIZE: "2" },
      routes: {
        "/api/Position/searchOpen": () => ({ ...OK, positions: [{ contractId: order.contractId, type: 1, size: 1 }, { contractId: "OTHER", type: 1, size: 5 }] }),
        "/api/Order/searchOpen": () => ({
          ...OK,
          orders: [
            { contractId: order.contractId, side: 0, type: 1, size: 1 }, // resting buy limit: counts
            { contractId: order.contractId, side: 1, type: 4, size: 1 }, // protective sell stop: ignored
          ],
        }),
      },
    });
    expect((await call("place_order", order)).text).toMatch(/net position to 3/);
    const flatten = await call("place_order", { ...order, side: "sell" });
    expect(flatten.isError).toBe(false);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
  });

  it("blocks new risk after the daily loss limit but still allows exits", async () => {
    const { call, api } = await setup({
      env: { PROJECTX_MAX_DAILY_LOSS: "200", PROJECTX_MAX_POSITION_SIZE: "5" },
      routes: {
        "/api/Position/searchOpen": () => ({ ...OK, positions: [{ contractId: order.contractId, type: 2, size: 1 }] }),
        "/api/Trade/search": () => ({ ...OK, trades: [{ profitAndLoss: -250, fees: 0, voided: false }] }),
      },
    });
    expect((await call("place_order", { ...order, side: "sell" })).text).toMatch(/Daily loss limit reached/);
    expect((await call("place_order", { ...order, side: "buy" })).isError).toBe(false);
    expect(api.bodiesFor("/api/Order/place")).toEqual([expect.objectContaining({ side: 0 })]);
  });
});

describe("order management tools", () => {
  const routes = {
    "/api/Order/modify": () => ({ ...OK }),
    "/api/Order/cancel": () => ({ success: false, errorCode: 6, errorMessage: "Follower accounts cannot cancel orders" }),
    "/api/Position/closeContract": () => ({ ...OK }),
    "/api/Position/partialCloseContract": () => ({ success: false, errorCode: 5, errorMessage: null }),
  };

  it("modify_order sends nulls for untouched fields and journals the reason", async () => {
    const { call, api, journal } = await setup({ routes });
    const res = await call("modify_order", { accountId: 1, orderId: 7, stopPrice: 100.5, reason: "stop to breakeven" });
    expect(res.data).toMatchObject({ success: true, errorName: "Success" });
    expect(api.bodiesFor("/api/Order/modify")[0]).toEqual({ accountId: 1, orderId: 7, size: null, limitPrice: null, stopPrice: 100.5, trailPrice: null });
    expect((await journal.read({ kind: "note" }))[0].text).toMatch(/breakeven/);
    expect((await call("modify_order", { accountId: 1, orderId: 7, size: 9 })).text).toMatch(/MAX_ORDER_SIZE/);
  });

  it("cancel_order reports AccountRejected", async () => {
    const { call } = await setup({ routes });
    expect((await call("cancel_order", { accountId: 1, orderId: 7 })).data).toMatchObject({ errorName: "AccountRejected", errorMessage: "Follower accounts cannot cancel orders" });
  });

  it("close and partial close journal the exit", async () => {
    const { call, journal, api } = await setup({ routes });
    expect((await call("close_position", { accountId: 1, contractId: "X", reason: "target hit" })).data.success).toBe(true);
    expect((await call("partial_close_position", { accountId: 1, contractId: "X", size: 3 })).data.errorName).toBe("InvalidCloseSize");
    expect(api.bodiesFor("/api/Position/partialCloseContract")[0]).toEqual({ accountId: 1, contractId: "X", size: 3 });
    expect((await journal.read({ kind: "exit" })).map((e) => e.text)).toEqual(["target hit", "partial close 3"]);
  });

  it("every write tool respects the account allow-list", async () => {
    const { call, api } = await setup({ env: { PROJECTX_ALLOWED_ACCOUNT_IDS: "99" }, routes });
    for (const [name, args] of [
      ["modify_order", { accountId: 1, orderId: 1 }],
      ["cancel_order", { accountId: 1, orderId: 1 }],
      ["close_position", { accountId: 1, contractId: "X" }],
      ["partial_close_position", { accountId: 1, contractId: "X", size: 1 }],
    ] as const) {
      expect((await call(name, args)).text).toMatch(/not in PROJECTX_ALLOWED_ACCOUNT_IDS/);
    }
    expect(api.calls).toHaveLength(0);
  });
});

describe("journal tools", () => {
  it("round-trips entries", async () => {
    const { call } = await setup();
    await call("journal_add", { kind: "lesson", text: "no trades in the first 5 minutes", tags: ["open"] });
    await call("journal_add", { kind: "plan", text: "trend day plan" });
    const { data } = await call("journal_read", { kind: "lesson" });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ kind: "lesson", tags: ["open"] });
  });
});

type Row = Record<string, unknown>;

/** A route that hangs until the request's timeout or deadline (a minute when it has neither), then fails like the client would. */
const hanger = (clock: ReturnType<typeof fakeClock>) => (path: string) => (_b: unknown, opts: PostOptions) => {
  const wait = Math.min(opts.timeoutMs ?? 60_000, (opts.deadline ?? Infinity) - clock.t);
  if (wait <= 0) throw new ProjectXError(`${path} not sent`, path, undefined, undefined, undefined, "deadline");
  clock.t += wait;
  throw new ProjectXError(`${path} timed out`, path, undefined, undefined, undefined, "timeout");
};
const MNQ = order.contractId;
const longPos = (size = 1) => ({ contractId: MNQ, type: 1, size, averagePrice: 21000 });
const stopLeg = (size = 1, id = 43) => ({ id, contractId: MNQ, type: 4, side: 1, size, status: 1 });
const targetLeg = { id: 44, contractId: MNQ, type: 1, side: 1, size: 1, status: 1 };
const bracketed = { ...order, stopLossBracket: { ticks: 10, type: "stop" }, takeProfitBracket: { ticks: 20, type: "limit" } };

/** A stateful fake broker for one bracketed market entry. */
function broker(o: {
  fill?: Row | null;
  positionAfter?: Row[];
  legs?: Row[];
  closeOk?: boolean;
  flatAfterClose?: boolean;
  cancelOk?: boolean;
  positionBefore?: Row[];
}) {
  const st = { placed: false, closed: false, cancelled: new Set<unknown>() };
  const routes = {
    "/api/Order/place": () => {
      st.placed = true;
      return { ...OK, orderId: 42 };
    },
    "/api/Order/search": () => ({ ...OK, orders: st.placed && o.fill ? [{ id: 42, contractId: MNQ, ...o.fill }] : [] }),
    "/api/Position/searchOpen": () => ({
      ...OK,
      positions: !st.placed ? (o.positionBefore ?? []) : st.closed && (o.flatAfterClose ?? true) ? [] : (o.positionAfter ?? [longPos()]),
    }),
    "/api/Order/searchOpen": () => ({ ...OK, orders: st.placed ? (o.legs ?? []).filter((x) => !st.cancelled.has(x.id)) : [] }),
    "/api/Position/closeContract": () => {
      st.closed = true;
      return o.closeOk === false ? { success: false, errorCode: 6, errorMessage: "halted" } : { ...OK };
    },
    "/api/Order/cancel": (b: any) => {
      if (b.orderId === 42 && o.fill?.status === 1) o.fill = { ...o.fill, status: 3 };
      if (o.cancelOk === false) return { success: false, errorCode: 6, errorMessage: "nope" };
      st.cancelled.add(b.orderId);
      return { ...OK };
    },
  };
  return { st, routes };
}

describe("place_order brackets", () => {
  it.each([
    ["buy", 10, 20, -10, 20],
    ["sell", 10, 20, 10, -20],
    ["buy", -10, -20, -10, 20],
    ["sell", -6, 8, 6, -8],
  ])("signs %s brackets by side (stop %i, target %i)", async (side, sl, tp, wantSl, wantTp) => {
    const { call, api } = await setup();
    const res = await call("place_order", {
      ...order, side, type: "limit", limitPrice: 21000, stopLossBracket: { ticks: sl, type: "stop" }, takeProfitBracket: { ticks: tp, type: "limit" },
    });
    expect(res.isError).toBe(false);
    const body = api.bodiesFor("/api/Order/place")[0];
    expect(body.stopLossBracket.ticks).toBe(wantSl);
    expect(body.takeProfitBracket.ticks).toBe(wantTp);
  });

  it.each([
    [{ stopLossBracket: { ticks: 3, type: "stop" } }, /stopLossBracket is 3 ticks/],
    [{ stopLossBracket: { ticks: -3, type: "stop" } }, /stopLossBracket is 3 ticks/],
    [{ takeProfitBracket: { ticks: 3, type: "limit" } }, /takeProfitBracket is 3 ticks/],
  ])("refuses a bracket under 4 ticks before sending (%o)", async (patch, msg) => {
    const { call, api, journal } = await setup();
    const res = await call("place_order", { ...order, ...patch });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Blocked by risk guardrail: /);
    expect(res.text).toMatch(msg);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(0);
    expect((await journal.read({ kind: "order_blocked" }))[0].text).toMatch(/minimum bracket distance is 4/);
  });

  it("returns a bracket refusal as is, sends exactly one POST, and logs the account setup fix", async () => {
    const { call, api, journal, warnings } = await setup({
      routes: { "/api/Order/place": () => ({ orderId: null, success: false, errorCode: 2, errorMessage: "Brackets cannot be used with Position Brackets." }) },
    });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ success: false, errorCode: 2, errorName: "OrderRejected" });
    expect(res.data.errorMessage).toBe(
      "Brackets cannot be used with Position Brackets. Enable Auto OCO Brackets for this account in the TopstepX dashboard; entries are not sent without brackets.",
    );
    expect(res.data.protection).toBeUndefined();
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
    expect(api.bodiesFor("/api/Order/search")).toHaveLength(0);
    const text = "Account ACC1 rejects bracket orders: enable Auto OCO Brackets on the TopstepX dashboard";
    expect(warnings).toEqual([text]);
    const [entry] = await journal.read({ tag: "auto-oco" });
    expect(entry).toMatchObject({ kind: "order_blocked", text, accountId: 1, contractId: MNQ, tags: ["account-setup", "auto-oco"], data: { accountId: 1, contractId: MNQ } });
  });

  it.each([4, 5])("treats errorCode %i as final: no retry, no protection flow, no setup warning", async (code) => {
    const { call, api, warnings } = await setup({
      routes: { "/api/Order/place": () => ({ orderId: null, success: false, errorCode: code, errorMessage: "bracket order outside hours" }) },
    });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
    expect(api.bodiesFor("/api/Order/search")).toHaveLength(0);
    expect(warnings).toEqual([]);
  });
});

describe("place_order protection after a bracketed market entry", () => {
  it("confirms the fill and the stop leg: protected", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000.25 }, legs: [stopLeg(), targetLeg] });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ success: true, orderId: 42 });
    expect(res.data.protection).toMatchObject({ status: "protected", stopOrderId: 43, filledSize: 1, fillPrice: 21000.25, targetPlaced: true });
    expect(api.bodiesFor("/api/Position/closeContract")).toHaveLength(0);
  });

  it("waits for a stop leg that shows up late", async () => {
    let checks = 0;
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 } });
    const { call } = await setup({
      routes: { ...b.routes, "/api/Order/searchOpen": () => ({ ...OK, orders: b.st.placed && ++checks > 3 ? [stopLeg()] : [] }) },
    });
    expect((await call("place_order", bracketed)).data.protection.status).toBe("protected");
  });

  it("a partial fill is protected when the stop leg covers the filled size", async () => {
    const b = broker({ fill: { status: 3, size: 2, fillVolume: 1, filledPrice: 21000 }, positionAfter: [longPos(1)], legs: [stopLeg(1)] });
    const { call } = await setup({ env: { PROJECTX_MAX_ORDER_SIZE: "2", PROJECTX_MAX_POSITION_SIZE: "2" }, routes: b.routes });
    const res = await call("place_order", { ...bracketed, size: 2 });
    expect(res.data.protection).toMatchObject({ status: "protected", filledSize: 1 });
  });

  it("a stop leg smaller than the position is not protection", async () => {
    const b = broker({ fill: { status: 2, size: 2, fillVolume: 2, filledPrice: 21000 }, positionAfter: [longPos(2)], legs: [stopLeg(1)] });
    const { call } = await setup({ env: { PROJECTX_MAX_ORDER_SIZE: "2", PROJECTX_MAX_POSITION_SIZE: "2" }, routes: b.routes });
    expect((await call("place_order", { ...bracketed, size: 2 })).data.protection.status).toBe("flattened_stop_unconfirmed");
  });

  it("flattens, cancels and verifies when the stop is never confirmed, and places no stop of its own", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, legs: [targetLeg, { ...stopLeg(), side: 0 }] });
    const { call, api, journal } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ success: true, orderId: 42 });
    expect(res.data.protection).toMatchObject({ status: "flattened_stop_unconfirmed", filledSize: 1, targetPlaced: false });
    expect(res.data.protection.message).toMatch(/flat/);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
    expect(api.bodiesFor("/api/Position/closeContract")).toEqual([{ accountId: 1, contractId: MNQ }]);
    expect(api.bodiesFor("/api/Order/cancel").map((x) => x.orderId).sort()).toEqual([43, 44]);
    const flat = await journal.read({ tag: "protection" });
    expect(flat.at(-1)!.text).toMatch(/flatten after unconfirmed stop.*-> flat/);
  });

  it("reports unknown, keeps the legs, and says a position may be open when the flatten fails", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, legs: [targetLeg], closeOk: false, flatAfterClose: false });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data.protection.status).toBe("unknown");
    expect(res.data.errorMessage).toMatch(/^UNPROTECTED POSITION MAY BE OPEN/);
    expect(res.data.errorMessage).toMatch(/close_position/);
    expect(res.data.errorMessage).not.toMatch(/blocked|refused|not sent/i);
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(0);
  });

  it("reports unknown when the legs cannot be cancelled after the flatten", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, legs: [targetLeg], cancelOk: false });
    const { call } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data.protection).toMatchObject({ status: "unknown", flatten: { status: "legs_left", remainingOrderIds: [44] } });
  });

  it("flattens when the order filled but its position never shows", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, positionAfter: [] });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.data.protection.status).toBe("flattened_stop_unconfirmed");
    expect(api.bodiesFor("/api/Position/closeContract")).toHaveLength(1);
  });

  it("cancels a market entry not seen filled in time and reports not_filled when nothing opened", async () => {
    const b = broker({ fill: { status: 1, size: 1, fillVolume: 0 }, positionAfter: [] });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({
      success: false, orderId: 42, errorCode: 2, errorName: "OrderRejected",
      errorMessage: "The market entry was not filled within the check window, so the server cancelled it; this entry opened nothing, and any earlier position is unchanged.",
      protection: { status: "not_filled" },
    });
    expect(api.bodiesFor("/api/Order/cancel")).toEqual([{ accountId: 1, orderId: 42 }]);
    expect(api.bodiesFor("/api/Position/closeContract")).toHaveLength(0);
  });

  it("flattens when a market entry not seen filled in time turns out to have opened a position", async () => {
    const b = broker({ fill: { status: 1, size: 1, fillVolume: 0 }, positionAfter: [] });
    let cancelled = false;
    const { call, api } = await setup({
      routes: {
        ...b.routes,
        "/api/Order/cancel": (body: any) => {
          if (body.orderId === 42) cancelled = true; // too late: it filled
          return { success: false, errorCode: 2, errorMessage: "not found" };
        },
        "/api/Position/searchOpen": () => ({ ...OK, positions: cancelled && !b.st.closed ? [longPos()] : [] }),
      },
    });
    const res = await call("place_order", bracketed);
    expect(res.data.protection.status).toBe("flattened_stop_unconfirmed");
    expect(api.bodiesFor("/api/Position/closeContract")).toHaveLength(1);
  });

  it("reports unknown when the unconfirmed entry cannot be checked at all", async () => {
    const b = broker({ fill: null });
    const { call } = await setup({
      routes: { ...b.routes, "/api/Position/searchOpen": () => (b.st.placed ? { success: false, errorCode: 1, errorMessage: null } : { ...OK, positions: [] }) },
    });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data.protection.status).toBe("unknown");
  });

  it("reports not_filled when the entry ends without a fill", async () => {
    const b = broker({ fill: { status: 5, size: 1, fillVolume: 0 }, positionAfter: [] });
    const { call } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({
      success: false, orderId: 42, errorCode: 2, errorName: "OrderRejected",
      errorMessage: "The broker ended the market entry without a fill (rejected); this entry opened nothing, and any earlier position is unchanged.",
      protection: { status: "not_filled" },
    });
  });

  it("uses the position when the order lookup fails, and measures the fill against the position before", async () => {
    const b = broker({ positionBefore: [longPos(1)], positionAfter: [longPos(2)], legs: [stopLeg(2)] });
    const { call } = await setup({
      env: { PROJECTX_MAX_POSITION_SIZE: "2" },
      routes: { ...b.routes, "/api/Order/search": () => ({ success: false, errorCode: 1, errorMessage: null }) },
    });
    const res = await call("place_order", bracketed);
    expect(res.data.protection).toMatchObject({ status: "protected", filledSize: 1, fillPrice: 21000 });
  });

  it("does not run the flow for a sell that only reduces a long", async () => {
    const b = broker({ positionBefore: [longPos(1)] });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("place_order", { ...bracketed, side: "sell" });
    expect(res.data.protection).toBeUndefined();
    expect(api.bodiesFor("/api/Order/search")).toHaveLength(0);
  });

  it("answers within 10 s when every request after the entry hangs until its timeout", async () => {
    const clock = fakeClock();
    const start = clock.t;
    const hang = hanger(clock);
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 } });
    const { call, api } = await setup({
      clock,
      routes: {
        ...b.routes,
        "/api/Order/searchOpen": (body, opts) => (b.st.placed ? hang("/api/Order/searchOpen")(body, opts) : { ...OK, orders: [] }),
        "/api/Position/closeContract": hang("/api/Position/closeContract"),
        "/api/Order/cancel": hang("/api/Order/cancel"),
        "/api/Order/place": (body, opts) => {
          clock.t += 1_500; // a slow but successful entry
          return b.routes["/api/Order/place"]();
        },
        "/api/Account/search": (body, opts) => {
          clock.t += 1_900; // slow pre-check
          return { ...OK, accounts: [{ id: 1, name: "ACC1", canTrade: true }] };
        },
      },
    });
    const res = await call("place_order", bracketed);
    expect(res.data.protection.status).toBe("unknown");
    expect(clock.t - start).toBeLessThanOrEqual(10_000);
    for (const c of api.calls) expect(c.opts.deadline ?? 0).toBeLessThanOrEqual(start + 10_000);
  });

  it("answers within 10 s when the entry itself hangs and the order cannot be found", async () => {
    const clock = fakeClock();
    const start = clock.t;
    const { call, api } = await setup({
      clock,
      routes: {
        "/api/Order/place": (body, opts) => {
          clock.t = opts.deadline!;
          throw new OrderOutcomeUnknownError("Unknown outcome; not re-sent (timed out). Check list_open_orders and list_open_positions before any retry.", body.customTag);
        },
      },
    });
    const res = await call("place_order", bracketed);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ outcome: "unknown", orderId: null, customTag: expect.stringMatching(/^pxm-/) });
    expect(res.data.errorMessage).toMatch(/^Unknown outcome; not re-sent/);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
    expect(clock.t - start).toBeLessThanOrEqual(10_000);
  });

  it("passes the caller's customTag through", async () => {
    const { call, api } = await setup();
    await call("place_order", { ...order, customTag: "mine-1" });
    expect(api.bodiesFor("/api/Order/place")[0].customTag).toBe("mine-1");
  });
});

describe("place_order canTrade pre-check", () => {
  const locked = { "/api/Account/search": () => ({ ...OK, accounts: [{ id: 1, name: "ACC1", canTrade: false }] }) };

  it("refuses an opening order on a locked account as AccountViolation and journals it", async () => {
    const { call, api, journal } = await setup({ routes: locked });
    const res = await call("place_order", order);
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ success: false, errorCode: 4, errorName: "AccountViolation", errorMessage: expect.stringMatching(/^Blocked by risk guardrail: .*canTrade=false/) });
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(0);
    expect((await journal.read({ kind: "order_blocked" }))[0].text).toMatch(/canTrade=false/);
  });

  it("still allows an order that only reduces the position", async () => {
    const { call, api } = await setup({
      routes: { ...locked, "/api/Position/searchOpen": () => ({ ...OK, positions: [longPos(1)] }) },
    });
    expect((await call("place_order", { ...order, side: "sell" })).isError).toBe(false);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
  });

  it("does not block when the account lookup fails", async () => {
    const { call, api } = await setup({ routes: { "/api/Account/search": () => ({ success: false, errorCode: 1, errorMessage: null }) } });
    expect((await call("place_order", order)).isError).toBe(false);
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(1);
  });

  it("does not block a reducing order when the daily P&L lookup fails", async () => {
    const { call } = await setup({
      env: { PROJECTX_MAX_DAILY_LOSS: "200" },
      routes: {
        "/api/Position/searchOpen": () => ({ ...OK, positions: [longPos(1)] }),
        "/api/Trade/search": () => ({ success: false, errorCode: 1, errorMessage: null }),
      },
    });
    expect((await call("place_order", { ...order, side: "sell" })).isError).toBe(false);
    expect((await call("place_order", order)).text).toMatch(/Trade\/search failed/);
  });
});

describe("close_position", () => {
  const routes = (o: { closeOk?: boolean; flatAfterClose?: boolean; cancelOk?: boolean; legs?: Row[] }) => {
    const b = broker({ ...o, legs: o.legs ?? [stopLeg(), targetLeg, { ...targetLeg, id: 99, contractId: "OTHER" }] });
    b.st.placed = true;
    return b;
  };

  it("closes, cancels the leftover legs on that contract, verifies, and reports flat", async () => {
    const b = routes({});
    const { call, api, journal } = await setup({ routes: b.routes });
    const res = await call("close_position", { accountId: 1, contractId: MNQ, reason: "target hit" });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ status: "flat", success: true, cancelledOrderIds: [43, 44], remainingOrderIds: [], close: { success: true } });
    expect(api.bodiesFor("/api/Order/cancel").map((x) => x.orderId)).toEqual([43, 44]);
    expect((await journal.read({ kind: "exit" }))[0]).toMatchObject({ text: "target hit", data: { status: "flat" } });
  });

  it("reports flat and still cancels the legs when the close fails because it is already flat", async () => {
    const b = routes({ closeOk: false });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.data).toMatchObject({ status: "flat", close: { success: false, errorCode: 6 } });
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(2);
  });

  it("reports still_open and keeps the stop when the position stays open", async () => {
    const b = routes({ closeOk: false, flatAfterClose: false });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ status: "still_open", positionNet: 1 });
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(0);
  });

  it("reports legs_left when a leg cannot be cancelled", async () => {
    const b = routes({ cancelOk: false });
    const { call } = await setup({ routes: b.routes });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ status: "legs_left", remainingOrderIds: [43, 44] });
  });

  it("reports a close that got no reply and answers within 10 s", async () => {
    const clock = fakeClock();
    const start = clock.t;
    const b = routes({});
    const { call } = await setup({
      clock,
      routes: {
        ...b.routes,
        "/api/Position/closeContract": (_body, opts) => {
          b.st.closed = true;
          clock.t += opts.timeoutMs!;
          throw new ProjectXError("timed out", "/api/Position/closeContract", undefined, undefined, undefined, "timeout");
        },
        "/api/Order/searchOpen": (_body, opts) => {
          clock.t += opts.timeoutMs!;
          throw new ProjectXError("timed out", "/api/Order/searchOpen", undefined, undefined, undefined, "timeout");
        },
      },
    });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.data).toMatchObject({ status: "legs_left", remainingOrderIds: null, close: { success: false, errorMessage: expect.stringMatching(/no reply/) } });
    expect(clock.t - start).toBeLessThanOrEqual(10_000);
  });
});

describe("review round 1", () => {
  const shortPos = (size = 1) => ({ contractId: MNQ, type: 2, size, averagePrice: 21000 });
  const typeless = (size = 1) => ({ contractId: MNQ, size, averagePrice: 21000 });
  const locked = { "/api/Account/search": () => ({ ...OK, accounts: [{ id: 1, name: "ACC1", canTrade: false }] }) };
  const two = { PROJECTX_MAX_ORDER_SIZE: "2", PROJECTX_MAX_POSITION_SIZE: "2" };

  it("F1: a reversal is opening: refused on a locked account", async () => {
    const { call, api } = await setup({ env: two, routes: { ...locked, "/api/Position/searchOpen": () => ({ ...OK, positions: [longPos(1)] }) } });
    const res = await call("place_order", { ...order, side: "sell", size: 2 });
    expect(res.data).toMatchObject({ success: false, errorCode: 4, errorName: "AccountViolation" });
    expect(api.bodiesFor("/api/Order/place")).toHaveLength(0);
  });

  it("F1: a reversal is opening: the daily loss limit applies", async () => {
    const { call } = await setup({
      env: { ...two, PROJECTX_MAX_DAILY_LOSS: "100" },
      routes: { "/api/Position/searchOpen": () => ({ ...OK, positions: [longPos(1)] }), "/api/Trade/search": () => ({ ...OK, trades: [{ profitAndLoss: -150, fees: 0, voided: false }] }) },
    });
    expect((await call("place_order", { ...order, side: "sell", size: 2 })).text).toMatch(/Daily loss limit reached/);
    expect((await call("place_order", { ...order, side: "sell", size: 1 })).isError).toBe(false);
  });

  it("F1: a bracketed reversal runs protection and needs a stop covering the new short", async () => {
    const run = async (legSide: number) => {
      const b = broker({ fill: { status: 2, size: 2, fillVolume: 2, filledPrice: 21000 }, positionBefore: [longPos(1)], positionAfter: [shortPos(1)], legs: [{ ...stopLeg(2), side: legSide }] });
      const { call } = await setup({ env: two, routes: b.routes });
      return (await call("place_order", { ...bracketed, side: "sell", size: 2 })).data.protection;
    };
    expect(await run(0)).toMatchObject({ status: "protected", filledSize: 2 });
    expect((await run(1)).status).toBe("flattened_stop_unconfirmed");
  });

  it("F2: close_position never cancels the legs of a position without a direction", async () => {
    const b = broker({ positionAfter: [typeless()], closeOk: false, flatAfterClose: false, legs: [stopLeg()] });
    b.st.placed = true;
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.data).toMatchObject({ status: "still_open", positionSize: 1, positionNet: null });
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(0);
  });

  it("F2: with an unknown direction, canTrade=false does not refuse (it may be an exit) but limits still apply", async () => {
    const pos = { "/api/Position/searchOpen": () => ({ ...OK, positions: [typeless()] }) };
    const sent = await setup({ routes: { ...locked, ...pos } });
    expect((await sent.call("place_order", { ...order, side: "sell" })).isError).toBe(false);
    const limited = await setup({ env: { PROJECTX_MAX_POSITION_SIZE: "1" }, routes: pos });
    expect((await limited.call("place_order", { ...order, side: "sell" })).text).toMatch(/direction unknown/);
  });

  it("F2: a typeless position after the entry is open and must be covered on the side opposite the entry", async () => {
    const run = async (legSide: number) => {
      const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, positionAfter: [typeless()], legs: [{ ...stopLeg(), side: legSide }] });
      const { call } = await setup({ routes: b.routes });
      return (await call("place_order", bracketed)).data.protection.status;
    };
    expect(await run(1)).toBe("protected");
    expect(await run(0)).toBe("flattened_stop_unconfirmed");
  });

  it("F3: a slow entry still leaves at least 2 s to see the fill", async () => {
    const clock = fakeClock();
    const start = clock.t;
    let placedAt = Infinity;
    const b = broker({ legs: [stopLeg()] });
    const { call, api } = await setup({
      clock,
      routes: {
        ...b.routes,
        "/api/Account/search": () => {
          clock.t += 1_500;
          return { ...OK, accounts: [{ id: 1, name: "ACC1", canTrade: true }] };
        },
        "/api/Order/place": (_b, opts) => {
          clock.t += opts.timeoutMs!; // answers just inside its timeout
          placedAt = clock.t;
          return b.routes["/api/Order/place"]();
        },
        // The fill shows 1.8 s after the entry's reply.
        "/api/Order/search": () => ({ ...OK, orders: [{ id: 42, status: clock.t - placedAt >= 1_800 ? 2 : 1, size: 1, fillVolume: 0, filledPrice: 21000 }] }),
        "/api/Position/searchOpen": () => ({ ...OK, positions: clock.t - placedAt >= 1_800 ? [longPos()] : [] }),
      },
    });
    const res = await call("place_order", bracketed);
    expect(res.data.protection.status).toBe("protected");
    const place = api.calls.find((c) => c.path === "/api/Order/place")!;
    expect(place.opts.deadline).toBe(start + 3_500);
    expect(api.calls.filter((c) => c.path === "/api/Account/search")[0].opts.deadline).toBe(start + 1_500);
  });

  it("F3: pins each flatten step's deadline", async () => {
    const clock = fakeClock();
    const start = clock.t;
    const b = broker({ legs: [stopLeg()] });
    b.st.placed = true;
    const { call, api } = await setup({ clock, routes: b.routes });
    await call("close_position", { accountId: 1, contractId: MNQ });
    const D = start + 9_500;
    const first = (path: string) => api.calls.find((c) => c.path === path)!.opts;
    expect(first("/api/Position/closeContract")).toMatchObject({ deadline: D - 2_400, timeoutMs: 4_000 });
    expect(first("/api/Position/searchOpen").deadline).toBe(D - 1_800);
    expect(first("/api/Order/searchOpen").deadline).toBe(D - 1_200);
    expect(first("/api/Order/cancel").deadline).toBe(D - 600);
    expect(api.calls.filter((c) => c.path === "/api/Order/searchOpen").at(-1)!.opts.deadline).toBe(D);
  });

  it("F3: a slow close still leaves time to cancel the legs", async () => {
    const clock = fakeClock();
    const b = broker({ legs: [stopLeg()] });
    b.st.placed = true;
    const { call } = await setup({
      clock,
      routes: {
        ...b.routes,
        "/api/Position/closeContract": (_b, opts) => {
          b.st.closed = true;
          clock.t += opts.timeoutMs!; // the close lands, but its reply comes at the timeout
          throw new ProjectXError("timed out", "/api/Position/closeContract", undefined, undefined, undefined, "timeout");
        },
        "/api/Position/searchOpen": () => {
          clock.t += 1_000; // slow reads
          return { ...OK, positions: [] };
        },
      },
    });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.data).toMatchObject({ status: "flat", cancelledOrderIds: [43] });
  });

  it("F5: modify_order, cancel_order and partial_close_position answer within the budget", async () => {
    for (const [name, path, args] of [
      ["modify_order", "/api/Order/modify", { accountId: 1, orderId: 7, stopPrice: 100 }],
      ["cancel_order", "/api/Order/cancel", { accountId: 1, orderId: 7 }],
      ["partial_close_position", "/api/Position/partialCloseContract", { accountId: 1, contractId: MNQ, size: 1 }],
    ] as const) {
      const clock = fakeClock();
      const start = clock.t;
      const { call } = await setup({ clock, routes: { [path]: hanger(clock)(path) } });
      const res = await call(name, args);
      expect(res.isError).toBe(true);
      expect(clock.t - start).toBeLessThanOrEqual(10_000);
    }
  });

  it("F7: only a Position Brackets refusal is the Auto OCO setup problem", async () => {
    const { call, warnings, journal } = await setup({
      routes: { "/api/Order/place": () => ({ orderId: null, success: false, errorCode: 2, errorMessage: "Invalid bracket ticks" }) },
    });
    const res = await call("place_order", bracketed);
    expect(res.data.errorMessage).toBe("Invalid bracket ticks");
    expect(warnings).toEqual([]);
    expect(await journal.read({ tag: "auto-oco" })).toEqual([]);
  });

  it("F8: a late fill that grows the position past the stop leg is not protected", async () => {
    let reads = 0;
    const b = broker({ fill: { status: 2, size: 2, fillVolume: 1, filledPrice: 21000 }, legs: [stopLeg(1)] });
    const { call } = await setup({
      env: two,
      routes: {
        ...b.routes,
        "/api/Position/searchOpen": () => {
          if (!b.st.placed) return { ...OK, positions: [] };
          if (b.st.closed) return { ...OK, positions: [] };
          return { ...OK, positions: [longPos(++reads > 1 ? 2 : 1)] };
        },
      },
    });
    const res = await call("place_order", { ...bracketed, size: 2 });
    expect(res.data.protection.status).toBe("flattened_stop_unconfirmed");
  });
});

describe("review round 2", () => {
  const typeless = (size = 1) => ({ contractId: MNQ, size, averagePrice: 21000 });

  it("N2: a limit refusal on a position without a direction points to close_position", async () => {
    const pos = { "/api/Position/searchOpen": () => ({ ...OK, positions: [typeless()] }) };
    const limit = await setup({ env: { PROJECTX_MAX_POSITION_SIZE: "1" }, routes: pos });
    expect((await limit.call("place_order", { ...order, side: "sell" })).text).toMatch(/Position direction unknown; use close_position to exit\.$/);
    const loss = await setup({
      env: { PROJECTX_MAX_DAILY_LOSS: "100" },
      routes: { ...pos, "/api/Trade/search": () => ({ ...OK, trades: [{ profitAndLoss: -150, fees: 0, voided: false }] }) },
    });
    expect((await loss.call("place_order", { ...order, side: "sell" })).text).toMatch(/Daily loss limit reached.*Position direction unknown; use close_position to exit/);
    const known = await setup({ env: { PROJECTX_MAX_POSITION_SIZE: "1" }, routes: { "/api/Position/searchOpen": () => ({ ...OK, positions: [longPos(1)] }) } });
    expect((await known.call("place_order", order)).text).not.toMatch(/direction unknown/);
  });

  it("N3: an add on a typeless position that ends empty leaves the position and its orders alone", async () => {
    const b = broker({ fill: { status: 5, size: 1, fillVolume: 0 }, positionBefore: [typeless()], positionAfter: [typeless()], legs: [stopLeg()] });
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("place_order", bracketed);
    expect(res.data).toMatchObject({ success: false, errorCode: 2, errorName: "OrderRejected", protection: { status: "not_filled" } });
    expect(api.bodiesFor("/api/Position/closeContract")).toHaveLength(0);
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(0);
  });

  it("N4: a typeless position that grows counts as the fill when the order lookup fails", async () => {
    const b = broker({ positionBefore: [typeless(1)], positionAfter: [typeless(2)], legs: [stopLeg(2)] });
    const { call, api } = await setup({
      env: { PROJECTX_MAX_POSITION_SIZE: "2" },
      routes: { ...b.routes, "/api/Order/search": () => ({ success: false, errorCode: 1, errorMessage: null }) },
    });
    const res = await call("place_order", bracketed);
    expect(res.data.protection.status).toBe("protected");
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(0);
  });

  it("N4: a flatten with net 0 but open size reports still_open and keeps the legs", async () => {
    const b = broker({ positionAfter: [longPos(1), { contractId: MNQ, type: 2, size: 1 }], closeOk: false, flatAfterClose: false, legs: [stopLeg()] });
    b.st.placed = true;
    const { call, api } = await setup({ routes: b.routes });
    const res = await call("close_position", { accountId: 1, contractId: MNQ });
    expect(res.data).toMatchObject({ status: "still_open", positionNet: 0, positionSize: 2 });
    expect(api.bodiesFor("/api/Order/cancel")).toHaveLength(0);
  });
});

describe("tick rounding", () => {
  const tickRoute = (tickSize: number) => ({ "/api/Contract/searchById": () => ({ ...OK, contract: { id: MNQ, tickSize } }) });

  it.each([
    ["stop", "sell", "stopPrice", 20999.9, 20999.75],
    ["stop", "buy", "stopPrice", 21000.1, 21000.25],
    ["trailing_stop", "sell", "trailPrice", 20999.9, 20999.75],
    ["trailing_stop", "buy", "trailPrice", 21000.1, 21000.25],
    ["limit", "buy", "limitPrice", 21000.1, 21000],
    ["limit", "sell", "limitPrice", 21000.1, 21000.25],
  ])("place_order rounds a %s %s %s away from the market", async (type, side, field, from, to) => {
    const { call, api, journal } = await setup({ routes: tickRoute(0.25), env: { PROJECTX_MAX_POSITION_SIZE: "5" } });
    const res = await call("place_order", { ...order, type, side, [field]: from });
    expect(res.isError).toBe(false);
    expect(api.bodiesFor("/api/Order/place")[0][field]).toBe(to);
    expect(res.data.snapped).toEqual({ [field]: { from, to } });
    const [entry] = await journal.read({ kind: "order_placed" });
    expect((entry.data as any).result.snapped).toEqual({ [field]: { from, to } });
  });

  it("place_order fixes float noise and uses an MGC-style 0.1 tick", async () => {
    const noisy = await setup({ routes: tickRoute(0.25) });
    await noisy.call("place_order", { ...order, type: "limit", side: "sell", limitPrice: 30342.249999 });
    expect(noisy.api.bodiesFor("/api/Order/place")[0].limitPrice).toBe(30342.25);
    const mgc = await setup({ routes: tickRoute(0.1) });
    const res = await mgc.call("place_order", { ...order, type: "stop", side: "sell", stopPrice: 2650.37 });
    expect(mgc.api.bodiesFor("/api/Order/place")[0].stopPrice).toBe(2650.3);
    expect(res.data.snapped).toEqual({ stopPrice: { from: 2650.37, to: 2650.3 } });
  });

  it("place_order leaves on-grid prices untouched and reports nothing", async () => {
    const { call, api } = await setup({ routes: tickRoute(0.25) });
    const res = await call("place_order", { ...order, type: "limit", limitPrice: 21000.75 });
    expect(api.bodiesFor("/api/Order/place")[0].limitPrice).toBe(21000.75);
    expect(res.data.snapped).toBeUndefined();
  });

  it("place_order sends the price unchanged when the tick lookup fails, and still places the order", async () => {
    const { call, api } = await setup({ routes: { "/api/Contract/searchById": () => ({ success: false, errorCode: 8, errorMessage: "not found" }) } });
    const res = await call("place_order", { ...order, type: "limit", limitPrice: 21000.1 });
    expect(res.isError).toBe(false);
    expect(api.bodiesFor("/api/Order/place")[0].limitPrice).toBe(21000.1);
    expect(res.data.snapped).toBeUndefined();
  });

  it("place_order looks the tick size up once per contract, and not at all without a price", async () => {
    const { call, api } = await setup({ routes: tickRoute(0.25), env: { PROJECTX_MAX_POSITION_SIZE: "5" } });
    await call("place_order", order);
    expect(api.bodiesFor("/api/Contract/searchById")).toHaveLength(0);
    await call("place_order", { ...order, type: "limit", limitPrice: 21000.1 });
    await call("place_order", { ...order, type: "limit", limitPrice: 21000.1 });
    expect(api.bodiesFor("/api/Contract/searchById")).toEqual([{ contractId: MNQ }]);
  });

  const working = (side: number, type = 4) => ({ "/api/Order/searchOpen": () => ({ ...OK, orders: [{ id: 7, contractId: MNQ, side, type, size: 1, status: 1 }] }) });

  it.each([
    [1, "stopPrice", 20999.9, 20999.75],
    [0, "stopPrice", 21000.1, 21000.25],
    [0, "limitPrice", 21000.1, 21000],
    [1, "limitPrice", 21000.1, 21000.25],
  ])("modify_order rounds by the working order's side (%i) for %s", async (side, field, from, to) => {
    const { call, api, journal } = await setup({ routes: { ...tickRoute(0.25), ...working(side), "/api/Order/modify": () => ({ ...OK }) } });
    const res = await call("modify_order", { accountId: 1, orderId: 7, [field]: from });
    expect(api.bodiesFor("/api/Order/modify")[0][field]).toBe(to);
    expect(res.data).toMatchObject({ success: true, snapped: { [field]: { from, to } } });
    const [note] = await journal.read({ tag: "tick-snap" });
    expect(note).toMatchObject({ kind: "note", orderId: 7, data: { snapped: { [field]: { from, to } } } });
  });

  it("modify_order sends the price unchanged when the working order or its tick cannot be read", async () => {
    for (const routes of [
      { ...tickRoute(0.25), "/api/Order/searchOpen": () => ({ success: false, errorCode: 1, errorMessage: null }) },
      { ...tickRoute(0.25), "/api/Order/searchOpen": () => ({ ...OK, orders: [] }) },
      { ...tickRoute(0.25), "/api/Order/searchOpen": () => ({ ...OK, orders: [{ id: 7, contractId: MNQ, type: 4, size: 1 }] }) },
      { ...working(1), "/api/Contract/searchById": () => ({ success: false, errorCode: 8, errorMessage: null }) },
    ]) {
      const { call, api, journal } = await setup({ routes: { ...routes, "/api/Order/modify": () => ({ ...OK }) } });
      const res = await call("modify_order", { accountId: 1, orderId: 7, stopPrice: 20999.9 });
      expect(api.bodiesFor("/api/Order/modify")[0].stopPrice).toBe(20999.9);
      expect(res.data.snapped).toBeUndefined();
      expect(await journal.read({ tag: "tick-snap" })).toEqual([]);
    }
  });

  it("modify_order looks up no tick size for a size-only change", async () => {
    const { call, api } = await setup({ routes: { ...tickRoute(0.25), ...working(1), "/api/Order/modify": () => ({ ...OK }) } });
    await call("modify_order", { accountId: 1, orderId: 7, size: 1 });
    expect(api.bodiesFor("/api/Contract/searchById")).toHaveLength(0);
  });

  it("modify_order passes trailPrice through unchanged (it may be read back as a distance)", async () => {
    const { call, api } = await setup({ routes: { ...tickRoute(0.25), ...working(1, 5), "/api/Order/modify": () => ({ ...OK }) } });
    const res = await call("modify_order", { accountId: 1, orderId: 7, trailPrice: 20999.9 });
    expect(api.bodiesFor("/api/Order/modify")[0].trailPrice).toBe(20999.9);
    expect(res.data.snapped).toBeUndefined();
    // Even next to a price that is rounded.
    const both = await call("modify_order", { accountId: 1, orderId: 7, trailPrice: 20999.9, stopPrice: 20999.9 });
    expect(api.bodiesFor("/api/Order/modify")[1]).toMatchObject({ trailPrice: 20999.9, stopPrice: 20999.75 });
    expect(both.data.snapped).toEqual({ stopPrice: { from: 20999.9, to: 20999.75 } });
  });

  it.each([
    [1, 20999.9, 20999.6, 20999.75, 20999.5],
    [0, 21000.1, 21000.4, 21000.25, 21000.5],
  ])("modify_order rounds a stop-limit's limit the same way as its stop (side %i)", async (side, stopPrice, limitPrice, stopTo, limitTo) => {
    const { call, api } = await setup({ routes: { ...tickRoute(0.25), ...working(side, 3), "/api/Order/modify": () => ({ ...OK }) } });
    const res = await call("modify_order", { accountId: 1, orderId: 7, stopPrice, limitPrice });
    expect(api.bodiesFor("/api/Order/modify")[0]).toMatchObject({ stopPrice: stopTo, limitPrice: limitTo });
    expect(res.data.snapped).toEqual({ stopPrice: { from: stopPrice, to: stopTo }, limitPrice: { from: limitPrice, to: limitTo } });
  });

  it("a journal failure never turns a done modify_order into an error", async () => {
    const { call, journal } = await setup({ routes: { ...tickRoute(0.25), ...working(1), "/api/Order/modify": () => ({ ...OK }) } });
    journal.add = async () => {
      throw new Error("read-only disk");
    };
    const res = await call("modify_order", { accountId: 1, orderId: 7, stopPrice: 20999.9, reason: "trail up" });
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ success: true, snapped: { stopPrice: { from: 20999.9, to: 20999.75 } } });
  });
});

describe("empty lists", () => {
  it("list_accounts with no accounts is an error that names the flag and the API host", async () => {
    const { call } = await setup({
      env: { PROJECTX_API_URL: "https://gateway.example.com/some/path?x=1" },
      routes: { "/api/Account/search": () => ({ ...OK, accounts: [] }) },
    });
    const res = await call("list_accounts", { onlyActiveAccounts: false });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "No accounts returned for this login (onlyActiveAccounts=false, API gateway.example.com). Check that the account is active at the firm and that PROJECTX_API_URL is the firm's gateway.",
    );
    expect((await call("list_accounts")).text).toMatch(/onlyActiveAccounts=true/);
    const odd = await setup({ env: { PROJECTX_API_URL: "not a url" }, routes: { "/api/Account/search": () => ({ ...OK, accounts: [] }) } });
    expect((await odd.call("list_accounts")).text).toMatch(/API unknown\)/);
  });

  it("search_contracts with no results stays [] and logs one line", async () => {
    const { call, warnings } = await setup({ routes: { "/api/Contract/search": () => ({ ...OK, contracts: [] }) } });
    const res = await call("search_contracts", { searchText: "MNQX", live: true });
    expect(res.isError).toBe(false);
    expect(res.data).toEqual([]);
    expect(warnings).toEqual(['search_contracts: no contracts for searchText "MNQX" (live=true)']);
  });

  it("search_contracts with results logs nothing", async () => {
    const { call, warnings } = await setup({ routes: { "/api/Contract/search": () => ({ ...OK, contracts: [{ id: "A" }] }) } });
    await call("search_contracts", { searchText: "MNQ" });
    expect(warnings).toEqual([]);
  });
});

describe("reconcile hooks in the server", () => {
  it("get_server_config shows the reconcile interval and grace, off without trading", async () => {
    expect((await (await setup()).call("get_server_config")).data).toMatchObject({ reconcileSeconds: 30, reconcileGraceSeconds: 15 });
    const custom = await setup({ env: { PROJECTX_RECONCILE_SECONDS: "10", PROJECTX_RECONCILE_GRACE_SECONDS: "20" } });
    expect((await custom.call("get_server_config")).data).toMatchObject({ reconcileSeconds: 10, reconcileGraceSeconds: 20 });
    expect((await (await setup({ env: { PROJECTX_RECONCILE_SECONDS: "0" } })).call("get_server_config")).data.reconcileSeconds).toBe("off");
    expect((await (await setup({ env: { PROJECTX_TRADING_ENABLED: "false" } })).call("get_server_config")).data.reconcileSeconds).toBe("off");
    expect((await (await setup({ env: { PROJECTX_RECONCILE_SECONDS: "2" } })).call("get_server_config")).data.reconcileSeconds).toBe(5);
  });

  it("place_order journals order_sent before sending, even when its reply is lost", async () => {
    const clock = fakeClock(Date.parse("2026-03-10T15:00:00Z"));
    let journaledFirst = false;
    const s = await setup({
      clock,
      routes: {
        "/api/Order/place": (b: any) => {
          journaledFirst = true;
          throw new OrderOutcomeUnknownError("lost", b.customTag);
        },
      },
    });
    const add = s.journal.add.bind(s.journal);
    s.journal.add = async (e) => {
      if (e.kind === "order_sent") expect(journaledFirst).toBe(false);
      return add(e);
    };
    await s.call("place_order", order);
    const [e] = await s.journal.read({ kind: "order_sent" });
    expect(e).toMatchObject({ ts: "2026-03-10T15:00:00.000Z", accountId: 1, contractId: MNQ });
    expect(journaledFirst).toBe(true);
  });

  it("place_order still sends when the journal cannot be written, and journals nothing when a guardrail refuses it", async () => {
    const failing = await setup();
    failing.journal.add = async () => {
      throw new Error("read-only disk");
    };
    expect((await failing.call("place_order", order)).isError).toBe(false);
    expect(failing.api.bodiesFor("/api/Order/place")).toHaveLength(1);
    const off = await setup({ env: { PROJECTX_TRADING_ENABLED: "false" } });
    await off.call("place_order", order);
    expect(await off.journal.read({ kind: "order_sent" })).toEqual([]);
  });

  it("modify_order journals order_sent with the working order's contract before sending", async () => {
    let sentAt = -1;
    const s = await setup({
      routes: {
        "/api/Order/searchOpen": () => ({ ...OK, orders: [{ id: 7, contractId: MNQ, side: 1, type: 4, size: 1 }] }),
        "/api/Order/modify": () => {
          sentAt = s.api.calls.length;
          return { ...OK };
        },
      },
    });
    let journaledBefore = false;
    const add = s.journal.add.bind(s.journal);
    s.journal.add = async (e) => {
      if (e.kind === "order_sent") journaledBefore = sentAt === -1;
      return add(e);
    };
    await s.call("modify_order", { accountId: 1, orderId: 7, size: 1 });
    expect(journaledBefore).toBe(true);
    expect((await s.journal.read({ kind: "order_sent" }))[0]).toMatchObject({ accountId: 1, contractId: MNQ, orderId: 7 });
  });
});

describe("order_sent journal cap", () => {
  it.each([
    ["place_order", order, "/api/Order/place"],
    ["modify_order", { accountId: 1, orderId: 7, size: 1 }, "/api/Order/modify"],
  ] as const)("%s still sends within the budget when the journal write hangs", async (tool, args, path) => {
    const clock = fakeClock();
    const s = await setup({ clock, routes: { "/api/Order/modify": () => ({ ...OK }) } });
    s.journal.add = () => new Promise(() => {}); // never settles
    const t0 = Date.now();
    const res = await s.call(tool, args as Record<string, unknown>);
    const waited = Date.now() - t0;
    expect(res.isError).toBe(false);
    expect(s.api.bodiesFor(path)).toHaveLength(1);
    expect(waited).toBeGreaterThanOrEqual(190);
    expect(waited).toBeLessThan(2_000);
  });
});

describe("protection notes are capped", () => {
  it("a hanging journal does not delay a flattened entry's reply", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, legs: [targetLeg] });
    const s = await setup({ routes: b.routes });
    s.journal.add = () => new Promise(() => {});
    const t0 = Date.now();
    const res = await s.call("place_order", bracketed);
    expect(res.data.protection.status).toBe("flattened_stop_unconfirmed");
    // Two capped waits (the protection note, then order_placed) plus order_sent: well under the 5 s test timeout.
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("a hanging journal does not delay a protected entry's reply", async () => {
    const b = broker({ fill: { status: 2, size: 1, fillVolume: 1, filledPrice: 21000 }, legs: [stopLeg(), targetLeg] });
    const s = await setup({ routes: b.routes });
    s.journal.add = () => new Promise(() => {});
    const t0 = Date.now();
    expect((await s.call("place_order", bracketed)).data.protection.status).toBe("protected");
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("a market entry not seen filled is cancelled and answered despite a hanging journal", async () => {
    const b = broker({ fill: { status: 1, size: 1, fillVolume: 0 }, positionAfter: [] });
    const s = await setup({ routes: b.routes });
    s.journal.add = () => new Promise(() => {});
    const t0 = Date.now();
    expect((await s.call("place_order", bracketed)).data.protection.status).toBe("not_filled");
    expect(Date.now() - t0).toBeLessThan(2_500);
  });
});

