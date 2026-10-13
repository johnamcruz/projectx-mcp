import { describe, expect, it } from "vitest";
import { TickSizes, snapMode, snapPrices, snapToTick } from "../src/ticks.js";
import { OK, fakeApi } from "./helpers.js";

describe("snapToTick", () => {
  it("removes float noise", () => {
    expect(snapToTick(30342.249999, 0.25, "nearest")).toBe(30342.25);
    expect(snapToTick(30342.249999, 0.25, "up")).toBe(30342.25);
    // Noise of a few ulps never costs a whole tick in either direction.
    expect(snapToTick(30342.250000000004, 0.25, "down")).toBe(30342.25);
    expect(snapToTick(30342.249999999996, 0.25, "up")).toBe(30342.25);
    expect(snapToTick(0.1 + 0.2, 0.1, "down")).toBe(0.3);
    // 0.3 / 0.1 is 2.9999999999999996 and (0.1 + 0.2) / 0.1 is 3.0000000000000004: the epsilon keeps both on 0.3.
    expect(snapToTick(0.3, 0.1, "down")).toBe(0.3);
    expect(snapToTick(0.1 + 0.2, 0.1, "up")).toBe(0.3);
  });

  it("floors, ceils, or rounds an off-grid price", () => {
    expect(snapToTick(21000.1, 0.25, "down")).toBe(21000);
    expect(snapToTick(21000.1, 0.25, "up")).toBe(21000.25);
    expect(snapToTick(21000.1, 0.25, "nearest")).toBe(21000);
    expect(snapToTick(21000.2, 0.25, "nearest")).toBe(21000.25);
  });

  it("handles an MGC-style 0.1 tick without float noise", () => {
    expect(snapToTick(2650.37, 0.1, "down")).toBe(2650.3);
    expect(snapToTick(2650.31, 0.1, "up")).toBe(2650.4);
    expect(snapToTick(2650.3, 0.1, "down")).toBe(2650.3);
    expect(snapToTick(2650.3, 0.1, "up")).toBe(2650.3);
  });

  it("leaves on-grid prices untouched and ignores a bad tick", () => {
    for (const mode of ["down", "up", "nearest"] as const) expect(snapToTick(21000.75, 0.25, mode)).toBe(21000.75);
    expect(snapToTick(21000.1, 0, "down")).toBe(21000.1);
    expect(snapToTick(21000.1, Number.NaN, "down")).toBe(21000.1);
  });
});

describe("snapMode", () => {
  it("never moves a price toward the market or to a worse fill", () => {
    expect(snapMode("stopPrice", "sell")).toBe("down"); // a long's protective stop
    expect(snapMode("stopPrice", "buy")).toBe("up"); // a short's protective stop
    expect(snapMode("trailPrice", "sell")).toBe("down");
    expect(snapMode("trailPrice", "buy")).toBe("up");
    expect(snapMode("limitPrice", "buy")).toBe("down"); // never pay more
    expect(snapMode("limitPrice", "sell")).toBe("up");
  });
});

describe("snapPrices", () => {
  it("reports only what changed, and changes nothing without a tick", () => {
    expect(snapPrices({ limitPrice: 100.1, stopPrice: 99.5 }, "buy", 0.25)).toEqual({
      prices: { limitPrice: 100, stopPrice: 99.5 },
      snapped: { limitPrice: { from: 100.1, to: 100 } },
    });
    expect(snapPrices({ stopPrice: 99.6 }, "buy", null)).toEqual({ prices: { stopPrice: 99.6 }, snapped: {} });
  });
});

describe("TickSizes", () => {
  it("caches a tick size per contract and does not cache a failure", async () => {
    let fail = true;
    const api = fakeApi({
      "/api/Contract/searchById": (b) => {
        if (fail) throw new Error("down");
        return { ...OK, contract: { id: b.contractId, tickSize: b.contractId === "MGC" ? 0.1 : 0.25 } };
      },
    });
    const ticks = new TickSizes(api);
    expect(await ticks.get("MNQ")).toBeNull();
    fail = false;
    expect(await ticks.get("MNQ")).toBe(0.25);
    expect(await ticks.get("MNQ")).toBe(0.25);
    expect(await ticks.get("MGC")).toBe(0.1);
    expect(api.bodiesFor("/api/Contract/searchById")).toHaveLength(3);
  });

  it("returns null for a missing or zero tick size", async () => {
    const api = fakeApi({ "/api/Contract/searchById": (b) => ({ ...OK, contract: b.contractId === "A" ? null : { tickSize: 0 } }) });
    const ticks = new TickSizes(api);
    expect(await ticks.get("A")).toBeNull();
    expect(await ticks.get("B")).toBeNull();
  });
});
