import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Deps } from "./server.js";

export interface HttpOptions {
  authToken?: string;
}

/**
 * Always require a token: even a loopback bind is public once it sits behind a
 * tunnel (the usual way to reach ChatGPT), and the endpoint can place trades.
 */
export function assertSafeBinding({ authToken }: HttpOptions): void {
  if (!authToken || authToken.length < 16) {
    throw new Error("HTTP mode requires MCP_HTTP_AUTH_TOKEN (at least 16 characters): anyone who can reach the endpoint could trade your account.");
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * Stateless Streamable HTTP MCP endpoint, plus /healthz.
 * With an auth token, clients either send `Authorization: Bearer <token>` to /mcp,
 * or (for clients like ChatGPT that cannot set headers) use the URL /mcp/<token>.
 */
export function createHttpApp(deps: Deps, opts: HttpOptions, log: (...a: unknown[]) => void = () => {}): Server {
  assertSafeBinding(opts);
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    const pathToken = url.pathname.startsWith("/mcp/") ? decodeURIComponent(url.pathname.slice(5)) : undefined;
    if (url.pathname !== "/mcp" && pathToken === undefined) {
      res.writeHead(404).end();
      return;
    }
    const authorized = req.headers.authorization === `Bearer ${opts.authToken}` || pathToken === opts.authToken;
    if (!authorized) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no server-initiated SSE stream or session teardown.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    try {
      // A fresh MCP server per request, sharing the API client, token, and quote cache.
      const server = createServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (e) {
      log("request failed:", e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
  });
}
