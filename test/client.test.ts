import { describe, expect, it } from "vitest";
import { ProjectXClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function fakeFetch(handlers: Array<(url: string, init: RequestInit) => Response>) {
  const calls: Array<{ url: string; auth?: string; body: unknown }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(init.body as string) });
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected call ${url}`);
    return h(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("ProjectXClient", () => {
  it("logs in with the API key and sends the bearer token", async () => {
    const { fn, calls } = fakeFetch([
      () => reply(200, { token: "T1", success: true, errorCode: 0, errorMessage: null }),
      () => reply(200, { accounts: [], success: true, errorCode: 0, errorMessage: null }),
    ]);
    await new ProjectXClient(config, fn).post("/api/Account/search", { onlyActiveAccounts: true });
    expect(calls[0]).toMatchObject({ url: "https://api.topstepx.com/api/Auth/loginKey", body: { userName: "u", apiKey: "k" } });
    expect(calls[1].auth).toBe("Bearer T1");
  });

  it("explains login failures", async () => {
    const { fn } = fakeFetch([() => reply(200, { token: null, success: false, errorCode: 3, errorMessage: null })]);
    await expect(new ProjectXClient(config, fn).getToken()).rejects.toThrow(/InvalidCredentials/);
  });

  it("re-logs in once on 401", async () => {
    const { fn, calls } = fakeFetch([
      () => reply(200, { token: "T1", success: true, errorCode: 0 }),
      () => reply(401, {}),
      () => reply(200, { token: "T2", success: true, errorCode: 0 }),
      () => reply(200, { success: true, errorCode: 0 }),
    ]);
    await new ProjectXClient(config, fn).post("/api/Order/searchOpen", { accountId: 1 });
    expect(calls[3].auth).toBe("Bearer T2");
  });

  it("backs off and retries once on 429", async () => {
    const waits: number[] = [];
    const { fn } = fakeFetch([
      () => reply(200, { token: "T1", success: true, errorCode: 0 }),
      () => reply(429, {}),
      () => reply(200, { bars: [], success: true, errorCode: 0 }),
    ]);
    await new ProjectXClient(config, fn, async (ms) => void waits.push(ms)).post("/api/History/retrieveBars", {});
    expect(waits).toEqual([5000]);
  });

  it("throws on success=false unless allowFailure", async () => {
    const fail = { success: false, errorCode: 2, errorMessage: "Brackets cannot be used with Position Brackets." };
    const { fn } = fakeFetch([
      () => reply(200, { token: "T1", success: true, errorCode: 0 }),
      () => reply(200, fail),
      () => reply(200, fail),
    ]);
    const c = new ProjectXClient(config, fn);
    await expect(c.post("/api/Order/place", {})).rejects.toThrow(/errorCode 2 – Brackets/);
    await expect(c.post("/api/Order/place", {}, { allowFailure: true })).resolves.toMatchObject({ errorCode: 2 });
  });
});

describe("ProjectXClient token lifecycle", () => {
  it("reuses a fresh token and refreshes via validate after 20h", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers({ now: new Date("2025-01-01T00:00:00Z") });
    try {
      const { fn, calls } = fakeFetch([
        () => reply(200, { token: "T1", success: true, errorCode: 0 }),
        () => reply(200, { success: true, errorCode: 0, newToken: "T2" }),
        () => reply(200, { success: false, errorCode: 1 }),
        () => reply(200, { token: "T3", success: true, errorCode: 0 }),
      ]);
      const c = new ProjectXClient(config, fn);
      expect(await c.getToken()).toBe("T1");
      expect(await c.getToken()).toBe("T1");
      vi.setSystemTime(new Date("2025-01-01T21:00:00Z"));
      expect(await c.getToken()).toBe("T2");
      expect(calls[1]).toMatchObject({ url: expect.stringMatching(/Auth\/validate$/), auth: "Bearer T1" });
      vi.setSystemTime(new Date("2025-01-02T18:00:00Z"));
      expect(await c.getToken()).toBe("T3"); // validate failed -> fresh login
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-auth HTTP errors", async () => {
    const { fn } = fakeFetch([() => reply(200, { token: "T1", success: true, errorCode: 0 }), () => reply(500, { oops: 1 })]);
    await expect(new ProjectXClient(config, fn).post("/api/Order/place", {})).rejects.toThrow(/HTTP 500.*oops/);
  });

  it("shares one login across concurrent requests", async () => {
    const { fn, calls } = fakeFetch([
      () => reply(200, { token: "T1", success: true, errorCode: 0 }),
      () => reply(200, { success: true, errorCode: 0 }),
      () => reply(200, { success: true, errorCode: 0 }),
    ]);
    const c = new ProjectXClient(config, fn);
    await Promise.all([c.post("/a", {}), c.post("/b", {})]);
    expect(calls.filter((x) => x.url.endsWith("loginKey"))).toHaveLength(1);
  });
});
