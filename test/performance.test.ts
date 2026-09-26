import { describe, expect, it } from "vitest";
import { summarizeTrades, type Trade } from "../src/performance.js";

const t = (pnl: number | null, extra: Partial<Trade> = {}): Trade => ({
  id: 1, contractId: "CON.F.US.MNQ.Z25", creationTimestamp: "", price: 1, profitAndLoss: pnl, fees: 1, side: 0, size: 1,
  voided: false, orderId: 1, ...extra,
});

describe("summarizeTrades", () => {
  it("computes win rate, net, and profit factor from closing fills", () => {
    const s = summarizeTrades([t(null), t(100), t(null), t(-50), t(null), t(0), t(999, { voided: true })]).overall;
    expect(s).toMatchObject({ closingFills: 3, wins: 1, losses: 1, scratches: 1, winRate: 0.33, grossPnL: 50, fees: 6, netPnL: 44, profitFactor: 2 });
  });
  it("handles no trades", () => {
    expect(summarizeTrades([]).overall).toMatchObject({ closingFills: 0, winRate: null, netPnL: 0 });
  });
});
