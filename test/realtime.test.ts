import { HubConnectionState } from "@microsoft/signalr";
import { describe, expect, it } from "vitest";
import { MarketHub, buildSignalRConnection, type HubConnectionLike } from "../src/realtime.js";

function fakeConnection() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  let reconnected: () => Promise<void> = async () => {};
  let closed: () => void = () => {};
  const invoked: Array<[string, unknown]> = [];
  const conn = {
    state: HubConnectionState.Connected,
    on: (name: string, fn: (...a: any[]) => void) => void (handlers[name] = fn),
    onreconnected: (fn: () => Promise<void>) => void (reconnected = fn),
    onclose: (fn: () => void) => void (closed = fn),
    start: async () => {},
    stop: async () => {},
    invoke: async (method: string, arg: unknown) => void invoked.push([method, arg]),
  };
  return {
    conn: conn as unknown as HubConnectionLike,
    invoked,
    push: (id: string, q: object) => handlers.GatewayQuote(id, q),
    reconnect: () => reconnected(),
    close: () => closed(),
  };
}

describe("MarketHub", () => {
  it("subscribes once, merges partial quotes, and reports age", async () => {
    const f = fakeConnection();
    let builds = 0;
    const hub = new MarketHub("wss://x", async () => "T", () => (builds++, f.conn));
    const pending = hub.getQuote("C1", 1000);
    await new Promise((r) => setTimeout(r, 0));
    f.push("C1", { lastPrice: 10, bestBid: 9 });
    expect((await pending)?.quote).toEqual({ lastPrice: 10, bestBid: 9 });
    f.push("C1", { lastPrice: 11 });
    const second = await hub.getQuote("C1");
    expect(second?.quote).toEqual({ lastPrice: 11, bestBid: 9 });
    expect(second?.ageMs).toBeGreaterThanOrEqual(0);
    expect(f.invoked).toEqual([["SubscribeContractQuotes", "C1"]]);
    expect(builds).toBe(1);
  });

  it("returns null after the timeout when no quote arrives", async () => {
    const f = fakeConnection();
    const hub = new MarketHub("wss://x", async () => "T", () => f.conn);
    expect(await hub.getQuote("C2", 10)).toBeNull();
  });

  it("resubscribes on reconnect and reconnects after close", async () => {
    const f = fakeConnection();
    let builds = 0;
    const hub = new MarketHub("wss://x", async () => "T", () => (builds++, f.conn));
    await hub.getQuote("C1", 1);
    await f.reconnect();
    expect(f.invoked.filter(([m]) => m === "SubscribeContractQuotes")).toHaveLength(2);
    f.close();
    (f.conn as any).state = HubConnectionState.Disconnected;
    await hub.getQuote("C1", 1);
    expect(builds).toBe(2);
    await hub.close();
  });

  it("builds a real SignalR connection without connecting", () => {
    const conn = buildSignalRConnection("https://rtc.example.com/hubs/market", async () => "T");
    expect(conn.state).toBe(HubConnectionState.Disconnected);
  });
});
