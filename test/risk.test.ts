import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  RiskError,
  assertDailyLoss,
  assertPositionLimit,
  assertSymbolAllowed,
  assertTradingAllowed,
  increasesExposure,
  realizedNet,
  symbolRoot,
  tradingDayStart,
} from "../src/risk.js";

const cfg = (extra: Record<string, string> = {}) =>
  loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k", PROJECTX_TRADING_ENABLED: "true", ...extra });

describe("config", () => {
  it("requires credentials", () => {
    expect(() => loadConfig({})).toThrow(/PROJECTX_USERNAME/);
  });
  it("defaults to trading disabled and conservative limits", () => {
    const c = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" });
    expect(c.tradingEnabled).toBe(false);
    expect(c.maxOrderSize).toBe(1);
    expect(c.apiUrl).toBe("https://api.topstepx.com");
  });
});

describe("guardrails", () => {
  it("blocks when trading disabled or account not allowed", () => {
    expect(() => assertTradingAllowed(cfg({ PROJECTX_TRADING_ENABLED: "false" }), 1)).toThrow(RiskError);
    expect(() => assertTradingAllowed(cfg({ PROJECTX_ALLOWED_ACCOUNT_IDS: "5, 6" }), 1)).toThrow(/not in/);
    expect(() => assertTradingAllowed(cfg({ PROJECTX_ALLOWED_ACCOUNT_IDS: "5, 6" }), 6)).not.toThrow();
  });

  it("matches symbols by contract root", () => {
    expect(symbolRoot("CON.F.US.MNQ.Z25")).toBe("MNQ");
    expect(() => assertSymbolAllowed(cfg({ PROJECTX_ALLOWED_SYMBOLS: "mnq,MES" }), "CON.F.US.MNQ.Z25")).not.toThrow();
    expect(() => assertSymbolAllowed(cfg({ PROJECTX_ALLOWED_SYMBOLS: "MES" }), "CON.F.US.ENQ.Z25")).toThrow(/ENQ/);
  });

  it("allows risk-reducing orders past the position limit", () => {
    const c = cfg({ PROJECTX_MAX_POSITION_SIZE: "2" });
    expect(() => assertPositionLimit(c, { currentNet: 2, pendingSameSide: 0, side: "buy", size: 1 })).toThrow(/net position to 3/);
    expect(() => assertPositionLimit(c, { currentNet: 3, pendingSameSide: 0, side: "sell", size: 1 })).not.toThrow();
    expect(() => assertPositionLimit(c, { currentNet: -2, pendingSameSide: 0, side: "sell", size: 1 })).toThrow();
    expect(() => assertPositionLimit(c, { currentNet: 1, pendingSameSide: 1, side: "buy", size: 1 })).toThrow();
  });

  it("treats a reversal through flat as increasing exposure only if it ends larger", () => {
    expect(increasesExposure({ currentNet: 1, pendingSameSide: 0, side: "sell", size: 2 })).toBe(false);
    expect(increasesExposure({ currentNet: 1, pendingSameSide: 0, side: "sell", size: 3 })).toBe(true);
  });

  it("enforces the daily loss limit on realized net P&L", () => {
    const trades = [
      { profitAndLoss: null, fees: 1.4, voided: false },
      { profitAndLoss: -300, fees: 1.4, voided: false },
      { profitAndLoss: -1000, fees: 1.4, voided: true },
    ];
    expect(realizedNet(trades)).toBeCloseTo(-302.8);
    expect(() => assertDailyLoss(cfg({ PROJECTX_MAX_DAILY_LOSS: "300" }), realizedNet(trades))).toThrow(/Daily loss/);
    expect(() => assertDailyLoss(cfg({ PROJECTX_MAX_DAILY_LOSS: "500" }), realizedNet(trades))).not.toThrow();
    expect(() => assertDailyLoss(cfg({ PROJECTX_MAX_DAILY_LOSS: "0" }), -1e6)).not.toThrow();
  });
});

describe("tradingDayStart", () => {
  it("is 17:00 Chicago the previous day before 5pm (CDT)", () => {
    // 2025-07-16 10:00 CDT = 15:00Z -> day started 2025-07-15 17:00 CDT = 22:00Z
    expect(tradingDayStart(new Date("2025-07-16T15:00:00Z")).toISOString()).toBe("2025-07-15T22:00:00.000Z");
  });
  it("is 17:00 Chicago the same day after 5pm (CST)", () => {
    // 2025-01-15 18:30 CST = 00:30Z next day -> 2025-01-15 17:00 CST = 23:00Z
    expect(tradingDayStart(new Date("2025-01-16T00:30:00Z")).toISOString()).toBe("2025-01-15T23:00:00.000Z");
  });
});
