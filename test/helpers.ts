import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProjectXError, type ApiEnvelope } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { Journal } from "../src/journal.js";
import type { QuoteSource } from "../src/realtime.js";
import { createServer, type Deps } from "../src/server.js";

export const OK = { success: true, errorCode: 0, errorMessage: null };

type Route = (body: any) => ApiEnvelope | Record<string, unknown>;

/** Fake ProjectX API: routes by path, records every call, mirrors client.post's success=false handling. */
export function fakeApi(routes: Record<string, Route>) {
  const calls: Array<{ path: string; body: any }> = [];
  return {
    calls,
    bodiesFor: (path: string) => calls.filter((c) => c.path === path).map((c) => c.body),
    async post(path: string, body: unknown, opts: { allowFailure?: boolean } = {}) {
      calls.push({ path, body });
      const route = routes[path];
      if (!route) throw new Error(`no fake route for ${path}`);
      const res = route(body) as ApiEnvelope;
      if (!res.success && !opts.allowFailure) throw new ProjectXError(`${path} failed: errorCode ${res.errorCode}`, path, res.errorCode);
      return res as any;
    },
  };
}

export const defaultRoutes = (): Record<string, Route> => ({
  "/api/Account/search": () => ({ ...OK, accounts: [{ id: 1, name: "ACC1", balance: 50000, canTrade: true }, { id: 2, name: "ACC2", balance: 1, canTrade: true }] }),
  "/api/Position/searchOpen": () => ({ ...OK, positions: [] }),
  "/api/Order/searchOpen": () => ({ ...OK, orders: [] }),
  "/api/Trade/search": () => ({ ...OK, trades: [] }),
  "/api/Order/place": () => ({ ...OK, orderId: 42 }),
});

export async function setup(opts: { env?: Record<string, string>; routes?: Record<string, Route>; quote?: QuoteSource } = {}) {
  const config = loadConfig({
    PROJECTX_USERNAME: "trader",
    PROJECTX_API_KEY: "secret-key",
    PROJECTX_TRADING_ENABLED: "true",
    PROJECTX_JOURNAL_PATH: join(mkdtempSync(join(tmpdir(), "pxs-")), "journal.jsonl"),
    ...opts.env,
  });
  const api = fakeApi({ ...defaultRoutes(), ...opts.routes });
  const journal = new Journal(config.journalPath);
  const marketHub: QuoteSource = opts.quote ?? { getQuote: async () => null, close: async () => {} };
  const deps: Deps = { config, client: api, journal, marketHub };
  const server = createServer(deps);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = res.content[0].text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: !!res.isError, text, data };
  };
  return { api, journal, client, call, config };
}
