import { describe, expect, it } from "vitest";
import { signedBrackets } from "../src/protect.js";

// The broker's bracket convention: ticks are signed from the entry, so a long's stop is below (negative) and its target
// above (positive), and a short's the reverse. A wrong sign is refused by the API.
describe("signedBrackets", () => {
  it("a buy: stop negative, target positive", () => {
    expect(signedBrackets("buy", 20, 40)).toEqual({ stop: -20, target: 40 });
  });
  it("a sell: stop positive, target negative", () => {
    expect(signedBrackets("sell", 20, 40)).toEqual({ stop: 20, target: -40 });
  });
  it("the caller's sign never matters", () => {
    expect(signedBrackets("buy", -20, -40)).toEqual({ stop: -20, target: 40 });
    expect(signedBrackets("sell", -20, -40)).toEqual({ stop: 20, target: -40 });
  });
  it("a missing leg stays missing", () => {
    expect(signedBrackets("sell", 20, undefined)).toEqual({ stop: 20, target: undefined });
    expect(signedBrackets("buy", undefined, 40)).toEqual({ stop: undefined, target: 40 });
  });
});
