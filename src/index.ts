#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectXClient } from "./client.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { Journal } from "./journal.js";
import { MarketHub } from "./realtime.js";
import { createServer, type Deps } from "./server.js";

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
  log(`trading ${deps.config.tradingEnabled ? "ENABLED" : "disabled (read-only)"}; API ${deps.config.apiUrl}`);

  if (process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http") {
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? "127.0.0.1";
    createHttpApp(deps, { authToken: process.env.MCP_HTTP_AUTH_TOKEN?.trim() || undefined }, log).listen(port, host, () =>
      log(`Streamable HTTP MCP endpoint at http://${host}:${port}/mcp`),
    );
  } else {
    await createServer(deps).connect(new StdioServerTransport());
  }

  const shutdown = async () => {
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
