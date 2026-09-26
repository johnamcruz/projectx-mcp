import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeBinding, createHttpApp } from "../src/http.js";
import { loadConfig } from "../src/config.js";
import { Journal } from "../src/journal.js";
import { fakeApi, defaultRoutes } from "./helpers.js";

const deps = () => {
  const config = loadConfig({ PROJECTX_USERNAME: "u", PROJECTX_API_KEY: "k", PROJECTX_JOURNAL_PATH: "/nonexistent/j.jsonl" });
  return { config, client: fakeApi(defaultRoutes()), journal: new Journal(config.journalPath), marketHub: { getQuote: async () => null, close: async () => {} } };
};

let close: (() => void) | undefined;
afterEach(() => close?.());

const TOKEN = "test-token-0123456789";
const authed = (body: object) => ({ ...rpc(body), headers: { ...rpc(body).headers, Authorization: `Bearer ${TOKEN}` } });

async function start() {
  const app = createHttpApp(deps(), { authToken: TOKEN });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  close = () => app.close();
  return `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
}

const rpc = (body: object) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify(body),
});
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

describe("HTTP transport", () => {
  it("refuses to start without a strong auth token", () => {
    expect(() => assertSafeBinding({})).toThrow(/MCP_HTTP_AUTH_TOKEN/);
    expect(() => assertSafeBinding({ authToken: "short" })).toThrow(/16 characters/);
    expect(() => assertSafeBinding({ authToken: TOKEN })).not.toThrow();
  });

  it("serves health, 404, and 405", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { headers: authed(init).headers })).status).toBe(405);
  });

  it("requires the bearer token when configured", async () => {
    const base = await start();
    expect((await fetch(`${base}/mcp`, rpc(init))).status).toBe(401);
    expect((await fetch(`${base}/mcp`, authed(init))).status).toBe(200);
    expect((await fetch(`${base}/mcp/${TOKEN}`, rpc(init))).status).toBe(200);
    expect((await fetch(`${base}/mcp/wrong`, rpc(init))).status).toBe(401);
  });

  it("answers initialize and tools/list statelessly", async () => {
    const base = await start();
    const initRes = await (await fetch(`${base}/mcp`, authed(init))).json();
    expect(initRes.result.serverInfo.name).toBe("projectx-mcp");
    const list = await (await fetch(`${base}/mcp`, authed({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("place_order");
  });

  it("returns 500 on an unparseable body", async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    expect(res.status).toBe(500);
  });
});
