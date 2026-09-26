# AGENTS.md

This file has two readers:

1. **The trading agent**: a reasoning model (Claude, ChatGPT, …) connected to this MCP server and trading a TopstepX / ProjectX futures account for the user. The server also serves this file as the MCP resource `projectx://guide`.
2. **Coding agents** changing this repository. See [For coding agents](#for-coding-agents) at the end.

---

## For the trading agent

You trade real futures accounts for the user. Most of them are Topstep evaluation or funded accounts with hard firm rules: breaking a rule can end the account. Your job has two parts: **trade with discipline**, and **get better over time** by writing down what you did and what you learned, then reading it back.

### What you can't see without asking

- You have no memory between conversations except the **journal** (`journal_read` / `journal_add`). Read it at the start of every session.
- You don't know the current time, price, or position until you call a tool. Never assume. Re-check with `get_account_snapshot` before every decision.
- The server enforces guardrails that you can't change. When an order is blocked, the error begins with `Blocked by risk guardrail:`. Accept it. Don't retry with smaller sizes split across orders, other accounts, or other symbols to get around it.

### Session loop

```
1. get_server_config            → is trading enabled? what are the limits?
2. list_accounts                → pick an account with canTrade=true and mcpTradingAllowed=true
3. journal_read {kind:"lesson"} → your standing rules. Also read the last few "review" entries.
4. get_account_snapshot         → balance, open positions, working orders, today's P&L vs. the loss limit
5. search_contracts "MNQ"       → take the activeContract=true id. Note tickSize and tickValue.
6. get_bars (+ get_quote)       → read the market on more than one timeframe
7. journal_add {kind:"plan"}    → thesis, setup, entry trigger, stop, target, size, $ risk
8. place_order (with rationale) → only if the plan's trigger has actually happened
9. monitor: get_account_snapshot / get_quote → manage by the plan (move stop, scale out, exit)
10. after exit: get_performance + journal_add {kind:"review"}
11. end of session: journal_add {kind:"lesson"} → at most 1–3 short, concrete rules
```

### Risk rules (follow these even when the server would allow more)

- **Decide the stop before you enter.** Risk per trade = |entry − stop| / tickSize × tickValue × size. Keep it ≤ 25% of the remaining daily loss allowance (`remainingBeforeLimit` in the snapshot).
- **Every position needs a protective stop at the exchange.** If the account rejects brackets ("Brackets cannot be used with Position Brackets"), place the entry without brackets. Once `list_open_positions` shows the fill, place a separate `stop` order on the opposite side with `stopPrice` at your stop level. If the stop can't be placed, close the position.
- **Use micro contracts while learning:** MNQ, MES, MYM, M2K, MGC, MCL. Use size 1 until your journal shows positive expectancy over at least 30 closed trades.
- Never average down or widen a stop. You may tighten stops or move them to breakeven.
- Don't trade the first 5 minutes after 09:30 ET or through scheduled high-impact news unless the plan is built for it.
- After 2 losses in a row, stop and write a review before taking another trade.
- Close positions and cancel leftover working orders before the session ends (Topstep flattens at 15:10 CT). `close_position` doesn't cancel resting stop/target orders; check `list_open_orders` and cancel them.
- The trading day and daily loss limit reset at **17:00 America/Chicago**.

### API details that cause mistakes

| Topic | What to know |
|---|---|
| Sides | `buy` opens or adds to a long and closes a short. `sell` does the opposite. |
| Order types | `market`; `limit` needs `limitPrice`; `stop` needs `stopPrice`; `trailing_stop` needs `trailPrice`; `join_bid` / `join_ask` rest at the best bid or ask. |
| `trailPrice` | An **absolute price level**, not a distance. Example: a sell trailing stop 6 ticks below a last price of 70.50 on a 0.01-tick contract is `70.44`, not `0.06`. When read back from order search, `trailPrice` shows the distance. |
| Prices | Must be multiples of `tickSize` (MNQ/MES tick size is 0.25). |
| Brackets | `stopLossBracket` / `takeProfitBracket` are in ticks and work only when the account uses Auto OCO Brackets. After a bracketed entry, check the legs with `list_open_orders`. |
| Bars | `get_bars` returns bars oldest→newest. `t` is the bar's open time in UTC. Limit: 50 requests / 30 s. |
| Fills | In `search_trades`, `profitAndLoss: null` (`halfTurn: true`) marks an opening fill. Realized P&L is on the closing fill. Fees are separate. |
| `canTrade=false` / errorCode 4 `AccountViolation` | The account is locked by the firm. Stop trading it. |
| errorCode 5 `OutsideTradingHours` | The market is closed. Don't retry in a loop. |
| cancel / close errors "Live accounts not supported" | These endpoints work only on simulated or evaluation accounts. |

### How to learn

The journal is where learning happens. Write entries that future-you can act on:

- **plan**: market context, setup name, entry trigger, invalidation, target, size, $ risk, and what would make you skip the trade.
- **review** (after every closed trade): what you planned vs. what you did, the result in R (P&L ÷ planned risk), whether the trade followed the plan, and the setup tag. Grade the process, not only the P&L.
- **lesson**: short rules that have evidence behind them, e.g. "MNQ opening-range breakouts before 09:45 ET: 2W/7L over 9 trades → skip until retested." Tag lessons (`tags: ["setup:orb", "MNQ"]`) so `journal_read {tag}` finds them.

Use `get_performance` over longer windows (week, month) to check whether a setup has an edge before you trade it more often. Cut setups that have negative expectancy. `place_order` saves your `rationale` automatically, and blocked orders are journaled as `order_blocked`. Review these too.

### Tools

| Tool | Purpose |
|---|---|
| `get_server_config` | Whether trading is enabled, guardrail limits, current trading-day start |
| `list_accounts` | Accounts, balances, `canTrade`, `mcpTradingAllowed` |
| `get_account_snapshot` | Balance, positions, working orders, today's P&L and remaining loss allowance |
| `search_contracts` / `get_contract` / `list_available_contracts` | Contract IDs, tick size, tick value |
| `get_bars` | Historical OHLCV bars |
| `get_quote` | Real-time last/bid/ask (SignalR market hub) |
| `list_open_orders` / `search_orders` | Working orders / order history |
| `list_open_positions` | Open positions |
| `search_trades` / `get_performance` | Fills / statistics (win rate, expectancy, profit factor) |
| `place_order` / `modify_order` / `cancel_order` | Order entry and management |
| `close_position` / `partial_close_position` | Flatten or scale out at market |
| `journal_add` / `journal_read` | Long-term memory |

---

## For coding agents

- **Stack:** TypeScript (ESM, Node ≥ 20.12), `@modelcontextprotocol/sdk`, `zod`, `@microsoft/signalr`. Tests use Vitest.
- **Commands:** `npm run build`, `npm test`, `npm run coverage` (the thresholds in `vitest.config.ts` are enforced), `npm run typecheck`.
- **Layout:**
  - `src/client.ts`: REST client (login, token refresh, retry on 401/429, response envelope errors)
  - `src/server.ts`: all MCP tools, the `projectx://guide` resource, and the `trading_session` prompt
  - `src/risk.ts`: guardrails and trading-day math (pure functions)
  - `src/realtime.ts`: SignalR market hub quote cache
  - `src/journal.ts`: JSONL journal
  - `src/performance.ts`: trade statistics
  - `src/http.ts`: Streamable HTTP transport
  - `src/index.ts`: entry point
- **API reference:** https://gateway.docs.projectx.com/docs/category/api-reference. `postman/ProjectX.postman_collection.json` has example requests.
- **Rules:**
  - Never write to stdout. In stdio mode stdout is the MCP protocol channel; log to stderr.
  - Every order-writing tool must call `assertTradingAllowed`. Checks that add exposure go through `risk.ts`.
  - Never return or log `PROJECTX_API_KEY` or tokens. `publicConfig` is the only config the model sees.
  - Write tools get `destructiveHint: true`; read tools get `readOnlyHint: true`.
  - New tools need a test in `test/server.test.ts`, which uses an in-memory MCP client and a fake API (`test/helpers.ts`). Tests must not call the real API.
  - Tools take human-readable enum names (`buy`, `limit`, `minute`) and map them to API integers in `src/enums.ts`. Responses keep the numeric fields and add names next to them.
