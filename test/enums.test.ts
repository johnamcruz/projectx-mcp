import { describe, expect, it } from "vitest";
import { decorateOrder, decoratePosition, decorateTrade } from "../src/enums.js";
import { loadConfig, publicConfig } from "../src/config.js";

describe("enum decoration", () => {
  it("names order, position, and trade enums", () => {
    expect(decorateOrder({ status: 5, type: 5, side: 1 })).toMatchObject({ statusName: "rejected", typeName: "trailing_stop", sideName: "sell" });
    expect(decorateOrder({ status: 99, type: 0, side: 0 })).toMatchObject({ statusName: "unknown(99)", typeName: "unknown(0)", sideName: "buy" });
    expect(decoratePosition({ type: 2 }).direction).toBe("short");
    expect(decorateTrade({ side: 0, profitAndLoss: 5 })).toMatchObject({ sideName: "buy", halfTurn: false });
  });
});

describe("config parsing", () => {
  const base = { PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" };
  it("parses lists, numbers, URLs, and ~ paths", () => {
    const c = loadConfig({ ...base, PROJECTX_ALLOWED_ACCOUNT_IDS: "1,2", PROJECTX_API_URL: "https://x.test/", PROJECTX_MAX_DAILY_LOSS: "0", PROJECTX_JOURNAL_PATH: "~/j.jsonl" });
    expect(c).toMatchObject({ allowedAccountIds: [1, 2], apiUrl: "https://x.test", maxDailyLoss: 0 });
    expect(c.journalPath).not.toContain("~");
    expect(publicConfig(c)).toMatchObject({ maxDailyLoss: "off", allowedSymbols: "any", allowedAccountIds: [1, 2] });
    expect(JSON.stringify(publicConfig(c))).not.toContain('"k"');
  });
  it("rejects bad numbers and account IDs", () => {
    expect(() => loadConfig({ ...base, PROJECTX_MAX_ORDER_SIZE: "-1" })).toThrow(/non-negative/);
    expect(() => loadConfig({ ...base, PROJECTX_ALLOWED_ACCOUNT_IDS: "abc" })).toThrow(/non-integer/);
  });
});
