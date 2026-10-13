import { describe, expect, it } from "vitest";
import { OrderOutcomeUnknownError, ProjectXClient, ProjectXError } from "../src/client.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k" });
const reply = (status: number, body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
const ok = (extra: Record<string, unknown> = {}) => reply(200, { success: true, errorCode: 0, errorMessage: null, ...extra });
const login = () => ok({ token: "T1" });
/** A request that never answers until the client aborts it. */
const hang = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function fakeFetch(handlers: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
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

describe("ProjectXClient timeouts and retries", () => {
  const waitsOf = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it("times out a request that never answers and retries reads", async () => {
    const { waits, sleep } = waitsOf();
    const { fn, calls } = fakeFetch([login, hang, () => ok({ orders: [] })]);
    const res = await new ProjectXClient(config, fn, sleep).post("/api/Order/searchOpen", { accountId: 1 }, { timeoutMs: 20 });
    expect(res.success).toBe(true);
    expect(waits).toEqual([1000]);
    expect(calls).toHaveLength(3);
  });

  it("retries reads on 5xx and network errors with 1, 2, 4 s backoff, then gives up", async () => {
    const { waits, sleep } = waitsOf();
    const boom = () => {
      throw new TypeError("fetch failed");
    };
    const { fn, calls } = fakeFetch([login, () => reply(500, {}), boom, () => reply(503, {}), () => reply(502, { x: 1 })]);
    await expect(new ProjectXClient(config, fn, sleep).post("/api/Position/searchOpen", {})).rejects.toThrow(/HTTP 502/);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(calls).toHaveLength(5);
  });

  it("never re-sends a non-idempotent write after a 5xx, timeout or network error", async () => {
    for (const fail of [() => reply(500, {}), hang, () => Promise.reject(new TypeError("socket hang up"))]) {
      const { waits, sleep } = waitsOf();
      const { fn, calls } = fakeFetch([login, fail]);
      const err = await new ProjectXClient(config, fn, sleep).post("/api/Order/cancel", { accountId: 1, orderId: 5 }, { timeoutMs: 20 }).catch((e) => e);
      expect(err).toBeInstanceOf(ProjectXError);
      expect(err.kind).toBe("unknown_outcome");
      expect(err.message).toMatch(/not re-sent/);
      expect(calls.filter((c) => c.url.endsWith("/Order/cancel"))).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });

  it("always sends a customTag on Order/place, keeping the caller's", async () => {
    const { fn, calls } = fakeFetch([login, () => ok({ orderId: 1 }), () => ok({ orderId: 2 })]);
    const c = new ProjectXClient(config, fn);
    await c.post("/api/Order/place", { accountId: 1 });
    await c.post("/api/Order/place", { accountId: 1, customTag: "mine" });
    expect((calls[1].body as any).customTag).toMatch(/^pxm-[a-z0-9]+-[0-9a-f]{8}$/);
    expect((calls[2].body as any).customTag).toBe("mine");
  });

  it("finds a timed-out order by its customTag instead of re-sending it", async () => {
    const { fn, calls } = fakeFetch([
      login,
      hang,
      () => ok({ orders: [{ id: 76, customTag: "other", creationTimestamp: new Date().toISOString() }, { id: 77, customTag: "tag-1", status: 1, creationTimestamp: new Date().toISOString() }] }),
    ]);
    const res = await new ProjectXClient(config, fn, async () => {}).post<any>("/api/Order/place", { accountId: 1, customTag: "tag-1" }, { timeoutMs: 20 });
    expect(res).toMatchObject({ success: true, orderId: 77, recoveredByCustomTag: true });
    expect(calls.filter((c) => c.url.endsWith("/Order/place"))).toHaveLength(1);
    expect(calls[2]).toMatchObject({ url: expect.stringMatching(/Order\/search$/), body: { accountId: 1, endTimestamp: null } });
  });

  it("reports an unknown outcome when the timed-out order is not found", async () => {
    const { fn, calls } = fakeFetch([login, hang, () => ok({ orders: [{ id: 76, customTag: "other" }] })]);
    const err = await new ProjectXClient(config, fn, async () => {}).post("/api/Order/place", { accountId: 1, customTag: "tag-1" }, { timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderOutcomeUnknownError);
    expect(err.customTag).toBe("tag-1");
    expect(err.message).toMatch(/^Unknown outcome; not re-sent .*list_open_orders and list_open_positions/);
    expect(calls.filter((c) => c.url.endsWith("/Order/place"))).toHaveLength(1);
  });

  it("looks up a place that answered 5xx too, and reports unknown when the lookup fails", async () => {
    const { fn, calls } = fakeFetch([login, () => reply(502, {}), () => reply(200, { success: false, errorCode: 1, errorMessage: null })]);
    await expect(new ProjectXClient(config, fn, async () => {}).post("/api/Order/place", { accountId: 1 })).rejects.toBeInstanceOf(OrderOutcomeUnknownError);
    expect(calls.filter((c) => c.url.endsWith("/Order/place"))).toHaveLength(1);
  });

  it("treats success with a null orderId as unknown", async () => {
    const { fn } = fakeFetch([login, () => ok({ orderId: null }), () => ok({ orders: [] })]);
    const err = await new ProjectXClient(config, fn).post("/api/Order/place", { accountId: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderOutcomeUnknownError);
    expect(err.message).toMatch(/no orderId/);
  });

  it("honours Retry-After on 429, also for order writes", async () => {
    const { waits, sleep } = waitsOf();
    const { fn, calls } = fakeFetch([login, () => reply(429, {}, { "Retry-After": "3" }), () => ok({ orderId: 9 })]);
    const res = await new ProjectXClient(config, fn, sleep).post<any>("/api/Order/place", { accountId: 1 });
    expect(res.orderId).toBe(9);
    expect(waits).toEqual([3000]);
    expect(calls.filter((c) => c.url.endsWith("/Order/place"))).toHaveLength(2);
    expect((calls[1].body as any).customTag).toBe((calls[2].body as any).customTag);
  });

  it("reads an HTTP-date Retry-After and gives up on one too far away", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const { waits, sleep } = waitsOf();
    const { fn } = fakeFetch([
      login,
      () => reply(429, {}, { "Retry-After": new Date(now + 2000).toUTCString() }),
      () => reply(429, {}, { "Retry-After": "120" }),
    ]);
    await expect(new ProjectXClient(config, fn, sleep, () => now).post("/api/Order/searchOpen", {})).rejects.toThrow(/HTTP 429/);
    expect(waits).toEqual([2000]);
  });

  it("does not retry past the deadline, and does not send once it has passed", async () => {
    let t = 1_000_000;
    const { waits, sleep } = waitsOf();
    const { fn, calls } = fakeFetch([login, () => reply(500, {})]);
    const c = new ProjectXClient(config, fn, sleep, () => t);
    await expect(c.post("/api/Order/searchOpen", {}, { deadline: t + 500 })).rejects.toThrow(/HTTP 500/);
    expect(waits).toEqual([]);
    t += 1_000;
    const err = await c.post("/api/Order/place", {}, { deadline: t - 1 }).catch((e) => e);
    expect(err.kind).toBe("deadline");
    expect(calls).toHaveLength(2);
  });

  it("caps the per-request timeout by the deadline", async () => {
    let t = 0;
    const { fn } = fakeFetch([login, hang]);
    const started = Date.now();
    await expect(new ProjectXClient(config, fn, async () => {}, () => t).post("/api/Order/cancel", {}, { timeoutMs: 5_000, deadline: 30 })).rejects.toThrow(/timed out after 30 ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("ProjectXClient review round 1", () => {
  const at = (ms: number) => new Date(ms).toISOString();

  it("F4: stops waiting for a shared login at this caller's deadline, without sending", async () => {
    const { fn, calls } = fakeFetch([hang]);
    const c = new ProjectXClient(config, fn, async () => {});
    const first = c.post("/api/Account/search", {}, { timeoutMs: 300 }).catch((e) => e);
    const started = Date.now();
    const err = await c.post("/api/Order/place", { accountId: 1 }, { deadline: Date.now() + 30 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectXError);
    expect(err.kind).toBe("deadline");
    expect(Date.now() - started).toBeLessThan(250);
    expect(calls.filter((x) => x.url.endsWith("/Order/place"))).toHaveLength(0);
    await first;
  });

  it("F6: ignores an order with the same tag created before the send", async () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const { fn } = fakeFetch([login, () => reply(504, {}), () => ok({ orders: [{ id: 5, customTag: "t", status: 2, creationTimestamp: at(now - 30_000) }] })]);
    const err = await new ProjectXClient(config, fn, async () => {}, () => now).post("/api/Order/place", { accountId: 1, customTag: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderOutcomeUnknownError);
  });

  it("F6: allows a little clock skew", async () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const { fn } = fakeFetch([login, () => reply(504, {}), () => ok({ orders: [{ id: 5, customTag: "t", status: 1, creationTimestamp: at(now - 2_000) }] })]);
    const res = await new ProjectXClient(config, fn, async () => {}, () => now).post<any>("/api/Order/place", { accountId: 1, customTag: "t" });
    expect(res).toMatchObject({ success: true, orderId: 5 });
  });

  it("F6: refuses to bind when two orders carry the tag", async () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const { fn } = fakeFetch([
      login,
      () => reply(504, {}),
      () => ok({ orders: [{ id: 5, customTag: "t", creationTimestamp: at(now) }, { id: 6, customTag: "t", creationTimestamp: at(now + 10) }] }),
    ]);
    const err = await new ProjectXClient(config, fn, async () => {}, () => now).post("/api/Order/place", { accountId: 1, customTag: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderOutcomeUnknownError);
    expect(err.message).toMatch(/2 orders carry customTag t/);
  });

  it("F6: reports a found order's real status: rejected is success false", async () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    const { fn } = fakeFetch([login, () => reply(504, {}), () => ok({ orders: [{ id: 5, customTag: "t", status: 5, fillVolume: 0, creationTimestamp: at(now + 100) }] })]);
    const res = await new ProjectXClient(config, fn, async () => {}, () => now).post<any>("/api/Order/place", { accountId: 1, customTag: "t" }, { allowFailure: true });
    expect(res).toMatchObject({ success: false, errorCode: 2, orderId: 5, recoveredByCustomTag: true, errorMessage: expect.stringMatching(/status rejected/) });
  });
});
