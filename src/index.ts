#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProjectXClient } from "./client.js";
import { loadConfig } from "./config.js";
import { FlowFeed, contractExists } from "./flowfeed.js";
import { createHttpApp } from "./http.js";
import { Journal } from "./journal.js";
import { MarketHub } from "./realtime.js";
import { FlowRecorder } from "./recorder.js";
import { Reconciler } from "./reconcile.js";
import { createServer, type Deps } from "./server.js";
import { TickSizes } from "./ticks.js";
import { startNgrokTunnel, type Tunnel } from "./tunnel.js";

// stdout carries the MCP protocol in stdio mode, so all diagnostics go to stderr.
const log = (...args: unknown[]) => console.error("[projectx-mcp]", ...args);

function buildDeps(): Deps & { marketHub: MarketHub; flow: FlowFeed } {
  const config = loadConfig();
  const client = new ProjectXClient(config);
  const marketHub = new MarketHub(config.marketHubUrl, () => client.getToken());
  const ticks = new TickSizes(client);
  const warn = (line: string) => log(line);
  return {
    config,
    client,
    journal: new Journal(config.journalPath),
    marketHub,
    ticks,
    warn,
    // MCP mode: no startup subscriptions and no flow files; the flow tools subscribe on first use.
    flow: new FlowFeed({ hub: marketHub, ticks, warn, maxContracts: config.flowMaxContracts, validate: (id) => contractExists(client, id) }),
  };
}

/** `--record-flow`: run only the market-hub feeds for PROJECTX_FLOW_SYMBOLS and write minutes to PROJECTX_FLOW_DIR. */
async function recordFlow() {
  const config = loadConfig();
  const client = new ProjectXClient(config);
  const hub = new MarketHub(config.marketHubUrl, () => client.getToken());
  const recorder = new FlowRecorder({
    config,
    client,
    hub,
    ticks: new TickSizes(client),
    warn: (line) => log(line),
    onFatal: () => process.exit(1),
  });
  await recorder.start();
  log(`flow recorder: ${recorder.symbols.join(", ")} → ${recorder.dir} (lock ${recorder.lock.path})`);
  const shutdown = async () => {
    await recorder.stop().catch(() => {});
    process.exit(0);
  };
  process.on("exit", () => recorder.lock.release());
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const envFile = process.env.PROJECTX_ENV_FILE ?? ".env";
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  if (process.argv.includes("--record-flow")) return recordFlow();

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

  // REST protection check: only with trading enabled and PROJECTX_RECONCILE_SECONDS > 0.
  const reconciler = new Reconciler({ config: deps.config, client: deps.client, journal: deps.journal, warn: deps.warn });
  if (reconciler.start()) {
    log(`reconcile every ${reconciler.intervalSeconds} s (grace ${deps.config.reconcileGraceSeconds} s, lock ${reconciler.lock.path})`);
  }

  const shutdown = async () => {
    await reconciler.stop().catch(() => {});
    await tunnel?.close().catch(() => {});
    await deps.flow.close().catch(() => {});
    await deps.marketHub.close().catch(() => {});
    process.exit(0);
  };
  // The release is synchronous, so it also runs when the process ends without a signal (stdin closed).
  process.on("exit", () => reconciler.lock.release());
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log(e instanceof Error ? e.message : e);
  process.exit(1);
});
