import { describe, expect, it } from "vitest";
import { OK, setup } from "./helpers.js";

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
      trailPrice: null, customTag: null, stopLossBracket: { ticks: 20, type: 4 }, takeProfitBracket: { ticks: 40, type: 1 },
    });
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
