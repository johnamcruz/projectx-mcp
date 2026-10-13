import { HubConnectionState } from "@microsoft/signalr";
import { describe, expect, it } from "vitest";
import { FlowFeed } from "../src/flowfeed.js";
import { MarketHub, buildSignalRConnection, type HubConnectionLike } from "../src/realtime.js";

function fakeConnection() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  let reconnected: () => Promise<void> = async () => {};
  let reconnecting: () => void = () => {};
  let closed: () => void = () => {};
  const invoked: Array<[string, unknown]> = [];
  const conn = {
    state: HubConnectionState.Connected,
    on: (name: string, fn: (...a: any[]) => void) => void (handlers[name] = fn),
    onreconnecting: (fn: () => void) => void (reconnecting = fn),
    onreconnected: (fn: () => Promise<void>) => void (reconnected = fn),
    onclose: (fn: () => void) => void (closed = fn),
    start: async () => {},
    stop: async () => {},
    invoke: async (method: string, arg: unknown) => {
      invoked.push([method, arg]);
      if (failing.has(method)) throw new Error(`${method} refused`);
    },
  };
  const failing = new Set<string>();
  return {
    conn: conn as unknown as HubConnectionLike,
    invoked,
    failing,
    handlers,
    push: (id: string, q: object) => handlers.GatewayQuote(id, q),
    reconnecting: () => reconnecting(),
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

  it("passes trades, depth and quotes to listeners and isolates a throwing listener", async () => {
    const f = fakeConnection();
    const hub = new MarketHub("wss://x", async () => "T", () => f.conn);
    const seen: unknown[] = [];
    hub.addListener({ trade: () => { throw new Error("listener bug"); } });
    const remove = hub.addListener({
      trade: (id, d) => void seen.push(["trade", id, d]),
      depth: (id, d) => void seen.push(["depth", id, d]),
      quote: (id, d) => void seen.push(["quote", id, d]),
      subscribed: (k, id) => void seen.push(["subscribed", k, id]),
    });
    await hub.subscribe("trades", "C1");
    await hub.subscribe("depth", "C1");
    expect(() => f.handlers.GatewayTrade("C1", [{ price: 1 }])).not.toThrow();
    f.handlers.GatewayDepth("C1", [{ type: 6 }]);
    f.handlers.GatewayQuote("C1", { bestBid: 1 });
    f.handlers.GatewayTrade(42, []); // not a contract id: dropped
    f.handlers.GatewayDepth(null, []);
    f.handlers.GatewayQuote("C1", null);
    expect(seen).toEqual([
      ["subscribed", "trades", "C1"],
      ["subscribed", "depth", "C1"],
      ["trade", "C1", [{ price: 1 }]],
      ["depth", "C1", [{ type: 6 }]],
      ["quote", "C1", { bestBid: 1 }],
    ]);
    expect(f.invoked).toEqual([["SubscribeContractTrades", "C1"], ["SubscribeContractMarketDepth", "C1"]]);
    remove();
    f.handlers.GatewayTrade("C1", []);
    expect(seen).toHaveLength(5);
  });

  it("reports drops, restores trade and depth subscriptions on reconnect, and unsubscribes", async () => {
    const f = fakeConnection();
    const hub = new MarketHub("wss://x", async () => "T", () => f.conn);
    const events: string[] = [];
    hub.addListener({ down: () => void events.push("down"), subscribed: (k, id) => void events.push(`${k}:${id}`) });
    await hub.subscribe("trades", "C1");
    await hub.subscribe("depth", "C1");
    f.reconnecting();
    f.failing.add("SubscribeContractMarketDepth");
    await f.reconnect();
    expect(events).toEqual(["trades:C1", "depth:C1", "down", "trades:C1"]);
    expect(f.invoked.map(([m]) => m)).toEqual(["SubscribeContractTrades", "SubscribeContractMarketDepth", "SubscribeContractTrades", "SubscribeContractMarketDepth"]);
    await hub.unsubscribe("trades", "C1");
    await hub.unsubscribe("trades", "C1"); // not subscribed: no call
    expect(f.invoked.at(-1)).toEqual(["UnsubscribeContractTrades", "C1"]);
    expect(f.invoked.filter(([m]) => m === "UnsubscribeContractTrades")).toHaveLength(1);
    f.close();
    expect(events.at(-1)).toBe("down");
    (f.conn as any).state = HubConnectionState.Disconnected;
    await hub.unsubscribe("depth", "C1"); // forgotten on close
    expect(f.invoked.filter(([m]) => m.startsWith("Unsubscribe"))).toHaveLength(1);
  });

  it("never builds a second connection while one is reconnecting, so each print counts once", async () => {
    const conns: ReturnType<typeof fakeConnection>[] = [];
    const hub = new MarketHub("wss://x", async () => "T", () => {
      const f = fakeConnection();
      conns.push(f);
      return f.conn;
    });
    let now = Date.UTC(2026, 9, 12, 14, 30, 10);
    const feed = new FlowFeed({ hub, now: () => now, warn: () => {}, timers: { every: () => 1, cancel: () => {} }, dropFailedSubscribes: false });
    await feed.ensure("C1");
    expect(conns).toHaveLength(1);
    const [c1] = conns;
    // The socket drops; SignalR is reconnecting it.
    (c1.conn as any).state = HubConnectionState.Reconnecting;
    c1.reconnecting();
    now += 5_000;
    await feed.tick(); // retries the missing subscriptions
    expect(conns).toHaveLength(1);
    expect(feed.coverage("C1").errors.trades).toMatch(/reconnecting/);
    (c1.conn as any).state = HubConnectionState.Connected;
    await c1.reconnect();
    now += 1_000;
    c1.handlers.GatewayTrade("C1", [{ price: 100, volume: 3, type: 0, timestamp: new Date(now).toISOString() }]);
    expect(feed.records("C1", now, now)[0].bv).toBe(3);
    // The connection closes for good: only now is a new one built.
    (c1.conn as any).state = HubConnectionState.Disconnected;
    c1.close();
    await feed.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(conns).toHaveLength(2);
    const [, c2] = conns;
    // A late close of the old connection must not clear the new one.
    c1.close();
    await hub.subscribe("trades", "C2");
    expect(conns).toHaveLength(2);
    await c2.reconnect();
    expect(c2.invoked.filter(([m]) => m === "SubscribeContractTrades").map(([, id]) => id)).toEqual(["C1", "C2", "C1", "C2"]);
    c2.handlers.GatewayTrade("C1", [{ price: 100, volume: 2, type: 1, timestamp: new Date(now).toISOString() }]);
    c1.handlers.GatewayTrade("C1", []); // the old one's handlers are dead weight; nothing doubles
    expect(feed.records("C1", now, now)[0]).toMatchObject({ bv: 3, sv: 2 });
    let stopped = 0;
    for (const f of conns) (f.conn as any).stop = async () => void stopped++;
    await hub.close();
    expect(stopped).toBe(1); // c1 is gone (closed); c2 is stopped
  });

  it("close() stops every connection it built, also one replaced before its close event", async () => {
    const conns: ReturnType<typeof fakeConnection>[] = [];
    const hub = new MarketHub("wss://x", async () => "T", () => {
      const f = fakeConnection();
      conns.push(f);
      return f.conn;
    });
    await hub.subscribe("trades", "C1");
    (conns[0].conn as any).state = HubConnectionState.Disconnected; // dead, onclose not delivered yet
    await hub.subscribe("trades", "C1");
    expect(conns).toHaveLength(2);
    let stopped = 0;
    for (const f of conns) (f.conn as any).stop = async () => void stopped++;
    await hub.close();
    expect(stopped).toBe(2);
  });

  it("a connection that fails to start is not kept, and reconnect events of a replaced connection are ignored", async () => {
    const conns: ReturnType<typeof fakeConnection>[] = [];
    let failStart = true;
    const hub = new MarketHub("wss://x", async () => "T", () => {
      const f = fakeConnection();
      if (failStart) (f.conn as any).start = async () => { throw new Error("401"); };
      conns.push(f);
      return f.conn;
    });
    const downs: number[] = [];
    hub.addListener({ down: () => void downs.push(1) });
    await expect(hub.subscribe("trades", "C1")).rejects.toThrow("401");
    failStart = false;
    await hub.subscribe("trades", "C1");
    conns[0].reconnecting();
    await conns[0].reconnect();
    expect(downs).toEqual([]);
    expect(conns[0].invoked).toEqual([]);
    let stopped = 0;
    for (const f of conns) (f.conn as any).stop = async () => void stopped++;
    await hub.close();
    expect(stopped).toBe(1);
  });

  it("builds a real SignalR connection without connecting", () => {
    const conn = buildSignalRConnection("https://rtc.example.com/hubs/market", async () => "T");
    expect(conn.state).toBe(HubConnectionState.Disconnected);
  });
});
