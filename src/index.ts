#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectXClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { Journal } from "./journal.js";
import { MarketHub } from "./realtime.js";
import { createServer, type Deps } from "./server.js";
import { startNgrokTunnel, type Tunnel } from "./tunnel.js";

// stdout carries the MCP protocol in stdio mode, so all diagnostics go to stderr.
const log = (...args: unknown[]) => console.error("[projectx-mcp]", ...args);

function buildDeps(): Deps {
  const config = loadConfig();
  const client = new ProjectXClient(config);
  return {
    config,
    client,
    journal: new Journal(config.journalPath),
    marketHub: new MarketHub(config.marketHubUrl, () => client.getToken()),
  };
}

async function main() {
  const envFile = process.env.PROJECTX_ENV_FILE ?? ".env";
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const deps = buildDeps();
  let tunnel: Tunnel | undefined;
  log(`trading ${deps.config.tradingEnabled ? "ENABLED" : "disabled (read-only)"}; API ${deps.config.apiUrl}`);

  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    const app = createHttpApp(deps, { authToken: process.env.MCP_HTTP_AUTH_TOKEN?.trim() || undefined }, log);
    await new Promise<void>((resolve) => app.listen(port, host, resolve));
    log(`Streamable HTTP MCP endpoint at http://${host}:${port}/mcp`);
    tunnel = await startNgrokTunnel(process.env, `${host}:${port}`);
    // The auth token is a credential, so print a placeholder rather than the full URL.
    if (tunnel) log(`ngrok tunnel established: ${tunnel.url}/mcp/<MCP_HTTP_AUTH_TOKEN>`);
  } else {
    await createServer(deps).connect(new StdioServerTransport());
  }

  const shutdown = async () => {
    await tunnel?.close().catch(() => {});
    await deps.marketHub.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log(e instanceof Error ? e.message : e);
  process.exit(1);
});
