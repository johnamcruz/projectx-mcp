# projectx-mcp

**An MCP server that gives a reasoning model (Claude, ChatGPT, or any MCP client) access to TopstepX so it can trade futures for you.**

The model connects through the [ProjectX Gateway API](https://gateway.docs.projectx.com/docs/category/api-reference), which powers TopstepX. It can read market data, place and manage orders, and track its positions and P&L. It also keeps a trading journal, so it can review its own trades and learn across sessions.

> [!WARNING]
> This software lets an AI place real orders on your account. Futures trading involves substantial risk of loss. AI models make mistakes: they misread data, hallucinate prices, and ignore instructions. Start with trading disabled, then use a practice or evaluation account, micro contracts, and tight guardrails. Watch the model trade before you trust it. You are responsible for every order it places.

## What the model gets

| Area | Tools |
|---|---|
| Session | `get_server_config`: is trading enabled, and what are the guardrails |
| Accounts | `list_accounts`, `get_account_snapshot` (balance, positions, working orders, today's P&L vs. the loss limit) |
| Market data | `search_contracts`, `get_contract`, `list_available_contracts`, `get_bars` (historical OHLCV), `get_quote` (real-time over SignalR) |
| Order flow | `get_top_of_book` (L1), `get_market_depth` (L2 book), `get_trades` (prints), `get_order_flow` (per-minute buy/sell volume, delta, OFI, book imbalance, cumulative delta), `get_footprint` (volume at price, POC, imbalances); see [Order flow](#order-flow) |
| Trading | `place_order` (market, limit, stop, trailing stop, join bid/ask, with optional brackets given as tick distances; after a bracketed market entry the server confirms the stop leg or closes the position), `modify_order`, `cancel_order`, `close_position` (also cancels the contract's working orders and verifies flat), `partial_close_position` |
| History | `list_open_orders`, `search_orders`, `list_open_positions`, `search_trades` |
| Learning | `get_performance` (win rate, expectancy, profit factor, by contract), `journal_add`, `journal_read` |

The server also sends the model an operating guide: the `projectx://guide` resource ([AGENTS.md](AGENTS.md)), the MCP server instructions, and a `trading_session` prompt. The guide covers the session loop (plan → trade → review → lesson), risk rules, and API details that commonly cause mistakes (for example, `trailPrice` is a price level, not a distance).

### How the model learns

Every `place_order` call requires a `rationale`, which is saved to a local journal (`~/.projectx-mcp/journal.jsonl`) with the result. The model is told to:

1. read its past `lesson` and `review` entries at the start of each session,
2. write a `plan` before trading,
3. write a `review` after each exit, graded against the plan and `get_performance`,
4. record short, evidence-based `lesson` entries for future sessions.

The model's weights don't change. It improves because it reads its own track record back each session.

### Guardrails the model cannot override

These are enforced in the server, before any request reaches TopstepX:

| Setting | Default | Effect |
|---|---|---|
| `PROJECTX_TRADING_ENABLED` | `false` | Order tools are refused unless this is `true`. Read-only tools always work. |
| `PROJECTX_ALLOWED_ACCOUNT_IDS` | any | Only these accounts can be traded. |
| `PROJECTX_ALLOWED_SYMBOLS` | any | Contract roots as they appear in contract IDs, e.g. `MNQ,MES` (`CON.F.US.MNQ.Z25` → `MNQ`; note that E-mini NQ is `ENQ` and ES is `EP`). |
| `PROJECTX_MAX_ORDER_SIZE` | `1` | Maximum contracts per order. |
| `PROJECTX_MAX_POSITION_SIZE` | `2` | Maximum absolute net position per contract, counting resting same-side limit orders. Orders that reduce the position are always allowed, except when the position's direction can't be read: then an order can't be told apart from an add, so it is checked like one, and you exit with `close_position`. |
| `PROJECTX_MAX_DAILY_LOSS` | `500` | Once realized P&L after fees for the trading day (from 17:00 CT) reaches −this amount, only orders that reduce the position are allowed (with the same exception for a position whose direction can't be read). `0` turns it off. Set it below your Topstep daily loss limit. |

Blocked orders are journaled as `order_blocked` so the model can review them.

Two more protections run without the model asking:

- **Tick rounding.** TopstepX rejects off-grid prices, so `place_order` and `modify_order` round prices onto the contract's tick grid, always away from the market or a worse fill:
  - Stops round down for a sell and up for a buy; limits round down for a buy and up for a sell.
  - A stop-limit's limit rounds the same way as its stop, so it never moves past the trigger.
  - `modify_order` reads the working order for its side and type. It passes `trailPrice` through unchanged, because a working trailing stop may read it back as a distance.
  - A changed price is reported as `snapped: { <field>: { from, to } }` and journaled. If the tick size or the order can't be read, the price is sent unchanged.
- **Protection check (reconcile).** With trading enabled, the server checks **its own trades** over REST every `PROJECTX_RECONCILE_SECONDS`.
  - **Scope:** the account + contract pairs it sent an order on within the window: since the trading day started (17:00 CT) or the last 24 hours, whichever reaches further back, so an overnight hold stays in scope after a restart. It reads them from the tail of the journal (never the whole file): `place_order` and `modify_order` write an `order_sent` entry before each send (waiting at most 200 ms for the write), so copies of the server sharing a journal see each other's orders. A position on an account + contract pair it hasn't traded in the window is never touched. A manual position on a pair it did trade is in scope.
  - **When it closes:** **a position of yours without a covering stop gets closed**. That is one not covered, for its whole size, by working stop or trailing-stop orders on the opposite side (a stop-limit doesn't count). It must be seen that way on two checks at least `PROJECTX_RECONCILE_GRACE_SECONDS` apart, with no order on that contract within the grace period, and a fresh read right before the close must confirm it.
  - **How it closes:** the same flatten as `close_position`, after one last look at the journal tail for an order on that pair within the grace period.
    - A successful close journals an `exit` tagged `reconcile` / `unprotected` and logs a warning.
    - Flat with working orders left over: a `note` ("flat; legs left: <ids>"). Those orders (only ones whose cancel failed, never a new order) are cancelled again on later checks while the contract stays flat.
    - A failed close journals a `note` ("close failed: …"). If the broker refused it, that contract waits 5 minutes. If there was no reply or it wasn't flat in time, it waits 1, then 2, then 5 minutes.
  - **What it never does:** cancel orders on an open position, or touch orders when you're flat.
  - **More than one copy:** if you run several copies against the same journal directory, only the copy holding `reconcile.lock` (next to the journal; taken over when stale or its process is gone) reads and closes positions.

| Setting | Default | Effect |
|---|---|---|
| `PROJECTX_RECONCILE_SECONDS` | `30` | Seconds between protection checks (at least 5; smaller values are raised to 5). `0` turns it off. It never runs with trading disabled. |
| `PROJECTX_RECONCILE_GRACE_SECONDS` | `15` | How long a position must stay uncovered (two checks this far apart), and how long after the last order on the contract (from any copy sharing the journal), before it is closed. |

`list_accounts` returns an error, not an empty list, when the login has no accounts: "No accounts returned for this login (onlyActiveAccounts=…, API <host>). Check that the account is active at the firm and that PROJECTX_API_URL is the firm's gateway."

## Order flow

The order-flow tools read ProjectX's SignalR market hub (trades, depth and quotes), which has no REST equivalent. The server runs in one of two modes.

**MCP mode (stdio or HTTP, the usual one): live snapshots.** The server subscribes to a contract on the first order-flow call for it, never at startup, so its data starts then. It checks the contract id first (an unknown one is refused and never takes a slot) and uses one SignalR connection, never a second one while it reconnects. It keeps the last 24 hours of minute rows, 5000 prints, 10,000 L1 changes and 20,000 L2 changes per contract, for at most 6 contracts. It never writes flow files. If `PROJECTX_FLOW_DIR` is set, `get_order_flow` and `get_footprint` also read the recorder's complete minutes from there (the tail of each file, never the whole file) and mark each row `source: "recorded"` or `"live"`; a recorded complete minute replaces a live one that isn't complete. Those reads are asynchronous and bounded: the JSONL only for the requested window, the small CSV rows back to the session start for the cumulative delta.

**Recorder mode: `projectx-mcp --record-flow`.** A long-running process that serves no MCP. It subscribes the active contract of each symbol in `PROJECTX_FLOW_SYMBOLS` on one SignalR connection, re-resolves them at each trading-day start (17:00 CT, so a roll switches contracts), and appends every complete minute to `PROJECTX_FLOW_DIR`:

- `<contractId>.csv`: `ISO-time,buy_volume,sell_volume`, no header, one row per complete minute (characters outside `A-Za-z0-9._-` in the id become `_`);
- `<contractId>.jsonl`: the full minute row, including volume at price.

Each minute is written once: on restart it reads the last complete line of each file and skips what is already there. A last line without its newline (a write cut short) is truncated away, never kept as data. Disconnects, silences and clock jumps are gaps, so a minute that touches one is never written. Only one recorder runs per directory (`recorder.lock`, taken over when its process is gone or its heartbeat is stale); a second one exits with a message. It needs both variables and exits with an error without them. It logs to stderr and stops cleanly on SIGINT/SIGTERM.

```bash
PROJECTX_FLOW_SYMBOLS=MNQ,MES PROJECTX_FLOW_DIR=~/.projectx-mcp/flow node dist/index.js --record-flow
```

[docs/FLOW-RECORDER.md](docs/FLOW-RECORDER.md) has a launchd example for running it as a background service on macOS.

| Setting | Default | Effect |
|---|---|---|
| `PROJECTX_FLOW_SYMBOLS` | none | Root symbols the recorder subscribes, e.g. `MNQ,MES`. Recorder mode only. |
| `PROJECTX_FLOW_DIR` | none | Where the recorder writes; MCP servers read recorded minutes from here. |
| `PROJECTX_FLOW_LARGE_PRINT` | `10` | Large-print threshold in contracts (`largeBuyVolume` / `largeSellVolume`); a tool call can override it. |
| `PROJECTX_FLOW_MAX_CONTRACTS` | `6` | Most contracts subscribed at once per process. |

A minute is `complete` only when:

- the trade subscription was confirmed before it started and stayed connected through its end;
- the minute has settled: a trade message arrived after its end plus 2 s (extended by the measured print delay, up to 10 s more), or else 10 s passed (`RECORDER_GRACE_MS`, plus the delay, at most 20 s). The recorder and the live tools use the same rule;
- hub messages for the contract kept arriving after the settle point, and no silence over 10 s (`SILENCE_LIMIT_MS`) touches the minute. A sleep or stall of the machine counts as a disconnect from the last message;
- the trade feed agrees with the quote feed: the quote's session `volume` did not rise by more than the printed volume plus max(2 contracts, 2 %), and a minute with no prints needs that volume known and flat and an unchanged `lastPrice`. Quote volume is counted by arrival time and prints by exchange time, so the previous minute's shortfall may explain quote volume received within the lag window after the boundary (max(1 s, the median delay), at most 5 s; one minute back, one live interval only), and a `lastPrice` move to the previous minute's last print price within that window is accepted. A minute with no prints must stay flat after the window. This catches a trade subscription that died while quotes keep flowing (counted in `tradeFeedMismatch`);
- the subscription started at least 2 s before the minute, measured in exchange time when this machine's clock is behind (warned once);
- every print in it had a timestamp with an explicit offset within 60 s of its arrival, and a known aggressor side.

Prints that arrive after their minute is final, or that are replayed after a reconnect, are counted and never applied. Minutes while the market is closed are incomplete (nothing arrives), so the recorder writes no rows for them. Consumers should use a bar only when all its minutes are complete.

**Unverified against the live hub.** These come from the ProjectX docs and haven't been checked against real pushes yet:

- the `GatewayTrade` `type` mapping: 0 = buy (aggressor lifted the ask), 1 = sell (`TRADE_SIDE_BY_TYPE` in `src/orderflow.ts`);
- the DomType enum of `GatewayDepth`: 0 Unknown, 1 Ask, 2 Bid, 3 BestAsk, 4 BestBid, 5 Trade, 6 Reset, 7 Low, 8 High, 9 NewBestBid, 10 NewBestAsk, 11 Fill (`DOM_TYPE`);
- the payload fields: trades `{symbolId, price, timestamp, type, volume}`, depth `{timestamp, type, price, volume, currentVolume}`, with the level size taken from `volume`;
- that GatewayQuote's `volume` is the session cumulative volume;
- that timestamps carry an explicit offset (`Z` or `±hh:mm`); one without is counted as bad;
- the `Unsubscribe*` hub method names, and that `GatewayTrade` / `GatewayDepth` arrive as `(contractId, data)`.

## Setup

Requires Node.js 20.12 or later.

```bash
git clone <this repo> projectx-mcp && cd projectx-mcp
npm install
npm run build
cp .env.example .env    # then edit .env
```

### Credentials

1. Sign in to TopstepX and open **Settings → API** ([topstepx.com/settings?tab=api](https://topstepx.com/settings?tab=api)). Create an API key. The API needs an active ProjectX API subscription.
2. Set `PROJECTX_USERNAME` to your **platform login username**. Don't use your email or an account name.
3. Set `PROJECTX_API_KEY` to the key.

Put these in `.env` (git-ignored), or in the `env` block of your MCP client config as shown below. Variables in the client config take precedence over `.env`. Set `PROJECTX_ENV_FILE` to load a `.env` from somewhere else. The server logs in, stores the session token, and refreshes it before the 24-hour expiry. It never shows the key or token to the model.

For another ProjectX-powered firm, set `PROJECTX_API_URL` and `PROJECTX_MARKET_HUB_URL` to that firm's [connection URLs](https://gateway.docs.projectx.com/docs/getting-started/connection-urls).

See [.env.example](.env.example) for every option.

## Use with Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "projectx": {
      "command": "node",
      "args": ["/absolute/path/to/projectx-mcp/dist/index.js"],
      "env": {
        "PROJECTX_USERNAME": "your-username",
        "PROJECTX_API_KEY": "your-api-key",
        "PROJECTX_TRADING_ENABLED": "false",
        "PROJECTX_ALLOWED_SYMBOLS": "MNQ,MES",
        "PROJECTX_MAX_ORDER_SIZE": "1",
        "PROJECTX_MAX_POSITION_SIZE": "1",
        "PROJECTX_MAX_DAILY_LOSS": "300"
      }
    }
  }
}
```

Restart Claude Desktop. **projectx** appears in the tools menu. To start, pick the `trading_session` prompt from the **+** menu, or ask: *"Read projectx://guide, then check my TopstepX accounts and plan a session on MNQ."*

Claude Desktop asks before each tool call by default. Keep that on until you trust the setup; it lets you approve every order.

### Claude Code

```bash
claude mcp add projectx \
  --env PROJECTX_USERNAME=your-username \
  --env PROJECTX_API_KEY=your-api-key \
  --env PROJECTX_TRADING_ENABLED=false \
  -- node /absolute/path/to/projectx-mcp/dist/index.js
```

Then run `/mcp` in Claude Code to confirm it's connected. Add `--scope user` to make it available in every project.

### Claude.ai (web or mobile)

Claude.ai connects to remote servers only. Run the HTTP transport (see [Remote access](#remote-access-http)), then add a custom connector under **Settings → Connectors** with the URL `https://<your-host>/mcp/<MCP_HTTP_AUTH_TOKEN>`.

## Use with ChatGPT

ChatGPT connects to remote MCP servers over HTTPS only, so this takes two steps.

**1. Run the server over HTTP and expose it with a tunnel.**

```bash
# in .env: credentials plus
MCP_HTTP_AUTH_TOKEN=$(openssl rand -hex 32)   # paste the generated value

NGROK_AUTHTOKEN=<your ngrok authtoken>        # optional: built-in ngrok tunnel
NGROK_DOMAIN=<name>.ngrok.app                 # optional: reserved domain for a stable URL

npm run start:http                              # listens on http://127.0.0.1:8787/mcp
```

With `NGROK_AUTHTOKEN` set, the server opens the tunnel itself and logs `ngrok tunnel established: https://…/mcp/<MCP_HTTP_AUTH_TOKEN>`. Without it, run any tunnel yourself (`cloudflared tunnel --url http://127.0.0.1:8787` or `ngrok http 8787`). Either way you get a public `https://…` URL. Without `NGROK_DOMAIN`, ngrok assigns a new URL on every start, so you'd have to update the connector each time.

**2. Add it to ChatGPT.** Turn on **Developer mode** (Settings → Apps & Connectors → Advanced settings), then create a connector:

- **MCP server URL:** `https://<tunnel-host>/mcp/<MCP_HTTP_AUTH_TOKEN>`
- **Authentication:** No authentication. The token in the URL is the credential.

Start a chat, enable the connector, and use a reasoning model. Ask it to *"Read the projectx guide resource and follow its session loop."* ChatGPT asks you to confirm write actions (`place_order` and similar), because those tools are annotated as destructive.

ChatGPT's menu names change from time to time. If these steps don't match what you see, check OpenAI's current documentation for connecting MCP servers or apps.

### Remote access (HTTP)

- `npm run start:http` (or `MCP_TRANSPORT=http`) serves Streamable HTTP at `/mcp` and a health check at `/healthz`.
- `MCP_HTTP_AUTH_TOKEN` is **required** (16+ characters). Clients send `Authorization: Bearer <token>`, or put the token in the path (`/mcp/<token>`) if they can't set headers. Anyone with the token can trade your account. Treat the URL as a password and rotate the token if it leaks.
- `HOST` and `PORT` default to `127.0.0.1:8787`. Keep the loopback bind and expose it through a tunnel instead of binding to `0.0.0.0`.
- `NGROK_AUTHTOKEN` (optional) starts a built-in ngrok tunnel to that address; `NGROK_DOMAIN` pins it to a reserved domain. It uses the optional `@ngrok/ngrok` dependency, so no separate ngrok binary is needed.

## Recommended rollout

1. **Read-only.** `PROJECTX_TRADING_ENABLED=false`. Let the model analyze, plan, and journal hypothetical trades.
2. **Practice account.** Enable trading, set `PROJECTX_ALLOWED_ACCOUNT_IDS` to a practice or combine account, micros only, size 1, and approve each order by hand.
3. **Supervised autonomy.** Loosen approvals only after the journal and `get_performance` show consistent, rule-following behavior over many trades.

## Development

```bash
npm run dev        # run from source with tsx (stdio)
npm test           # unit tests (Vitest)
npm run coverage   # tests + coverage report (thresholds enforced)
npm run typecheck
```

Every module in `src/` has unit tests in `test/`, except `index.ts`, which only wires dependencies together. Each MCP tool is exercised through an in-memory MCP client against a fake ProjectX API, so the tests never touch the real API. See [AGENTS.md](AGENTS.md#for-coding-agents) for code layout and conventions.

### Postman

[postman/ProjectX.postman_collection.json](postman/ProjectX.postman_collection.json) has example ProjectX requests. Import it, set the collection variables `username`, `apiKey`, and `accountId`, and run **Authenticate** first. It saves the token to `{{token}}` for the other requests.

## References

- ProjectX Gateway API docs: https://gateway.docs.projectx.com/docs/intro
- Rate limits: 50 requests / 30 s for `retrieveBars`, 200 requests / 60 s for everything else. Every request has a timeout. The client retries reads on timeouts, network errors and 5xx (1, 2, 4 s), waits for `Retry-After` on HTTP 429, and never re-sends an order write that may have reached the broker.
- Model Context Protocol: https://modelcontextprotocol.io

## License

Apache-2.0. See [LICENSE](LICENSE).
