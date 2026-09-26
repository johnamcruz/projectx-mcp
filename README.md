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
| Trading | `place_order` (market, limit, stop, trailing stop, join bid/ask, with optional brackets), `modify_order`, `cancel_order`, `close_position`, `partial_close_position` |
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
| `PROJECTX_MAX_POSITION_SIZE` | `2` | Maximum absolute net position per contract, counting resting same-side limit orders. Orders that reduce the position are always allowed. |
| `PROJECTX_MAX_DAILY_LOSS` | `500` | Once realized P&L after fees for the trading day (from 17:00 CT) reaches −this amount, only orders that reduce the position are allowed. `0` turns it off. Set it below your Topstep daily loss limit. |

Blocked orders are journaled as `order_blocked` so the model can review them.

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

npm run start:http                              # listens on http://127.0.0.1:8787/mcp
cloudflared tunnel --url http://127.0.0.1:8787  # or: ngrok http 8787
```

The tunnel prints a public `https://…` URL.

**2. Add it to ChatGPT.** Turn on **Developer mode** (Settings → Apps & Connectors → Advanced settings), then create a connector:

- **MCP server URL:** `https://<tunnel-host>/mcp/<MCP_HTTP_AUTH_TOKEN>`
- **Authentication:** No authentication. The token in the URL is the credential.

Start a chat, enable the connector, and use a reasoning model. Ask it to *"Read the projectx guide resource and follow its session loop."* ChatGPT asks you to confirm write actions (`place_order` and similar), because those tools are annotated as destructive.

ChatGPT's menu names change from time to time. If these steps don't match what you see, check OpenAI's current documentation for connecting MCP servers or apps.

### Remote access (HTTP)

- `npm run start:http` (or `MCP_TRANSPORT=http`) serves Streamable HTTP at `/mcp` and a health check at `/healthz`.
- `MCP_HTTP_AUTH_TOKEN` is **required** (16+ characters). Clients send `Authorization: Bearer <token>`, or put the token in the path (`/mcp/<token>`) if they can't set headers. Anyone with the token can trade your account. Treat the URL as a password and rotate the token if it leaks.
- `HOST` and `PORT` default to `127.0.0.1:8787`. Keep the loopback bind and expose it through a tunnel instead of binding to `0.0.0.0`.

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
- Rate limits: 50 requests / 30 s for `retrieveBars`, 200 requests / 60 s for everything else. The client backs off once on HTTP 429.
- Model Context Protocol: https://modelcontextprotocol.io

## License

Apache-2.0. See [LICENSE](LICENSE).
