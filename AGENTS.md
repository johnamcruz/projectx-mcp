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
- **Every position needs a protective stop at the exchange.** Enter with a `stopLossBracket`. If the account rejects brackets ("Brackets cannot be used with Position Brackets"), nothing was opened and the server does not send the entry without them: the owner must enable Auto OCO Brackets for this account in the TopstepX dashboard. Don't try to enter that account another way; the server journals the refusal (tags `account-setup`, `auto-oco`) so the owner sees it.
- **Use micro contracts while learning:** MNQ, MES, MYM, M2K, MGC, MCL. Use size 1 until your journal shows positive expectancy over at least 30 closed trades.
- Never average down or widen a stop. You may tighten stops or move them to breakeven.
- Don't trade the first 5 minutes after 09:30 ET or through scheduled high-impact news unless the plan is built for it.
- After 2 losses in a row, stop and write a review before taking another trade.
- Close positions before the session ends (Topstep flattens at 15:10 CT). `close_position` closes the position, then cancels every working order on that contract (stop/target legs and any other order there) and checks the result.
- The trading day and daily loss limit reset at **17:00 America/Chicago**.

### API details that cause mistakes

| Topic | What to know |
|---|---|
| Sides | `buy` opens or adds to a long and closes a short. `sell` does the opposite. |
| Order types | `market`; `limit` needs `limitPrice`; `stop` needs `stopPrice`; `trailing_stop` needs `trailPrice`; `join_bid` / `join_ask` rest at the best bid or ask. |
| `trailPrice` | An **absolute price level**, not a distance. Example: a sell trailing stop 6 ticks below a last price of 70.50 on a 0.01-tick contract is `70.44`, not `0.06`. When read back from order search, `trailPrice` shows the distance. |
| Prices | Must be multiples of `tickSize` (MNQ/MES tick size is 0.25). |
| Brackets | `stopLossBracket` / `takeProfitBracket` `ticks` are **distances** from the fill (at least 4 ticks); the server signs them by side, so send `10`, not `-10`. They work only when the account uses Auto OCO Brackets. |
| Bars | `get_bars` returns bars oldest→newest. `t` is the bar's open time in UTC. Limit: 50 requests / 30 s. |
| Fills | In `search_trades`, `profitAndLoss: null` (`halfTurn: true`) marks an opening fill. Realized P&L is on the closing fill. Fees are separate. |
| `canTrade=false` / errorCode 4 `AccountViolation` | The account is locked by the firm. Stop trading it. |
| errorCode 5 `OutsideTradingHours` | The market is closed. Don't retry in a loop. |
| cancel / close errors "Live accounts not supported" | These endpoints work only on simulated or evaluation accounts. |

### What `place_order` and `close_position` return

An order **reduces** only when it is on the opposite side of a known open position and no larger than it (long 2, sell 1 or 2). Everything else **opens**: a new position, an add, and a reversal through flat (long 1, sell 2). If a position's direction can't be read, orders on that contract count as opening for the position and daily-loss limits; a refusal then says "position direction unknown; use close_position to exit".

After a **market** entry with a `stopLossBracket` that opens, the server waits for the fill and checks that a working stop covers the whole new position, on the side opposite that position (for a reversal, the new side). It never places a stop of its own. If the fill isn't confirmed in time, it cancels the entry and checks the position. If anything opened, or the position can't be read, it closes the **whole** position on that contract, including any part that was open before this entry, and cancels every order there. `protection.status` in the result says what happened:

| `protection.status` | Meaning | What you do |
|---|---|---|
| `protected` | Filled, and the bracket's stop is working (`stopOrderId`). | Manage the trade by the plan. |
| `flattened_stop_unconfirmed` | Filled (or not confirmed filled in time), but no covering stop showed up, so the server closed the position, cancelled the orders on that contract, and confirmed flat. | Treat it as a closed trade and review it. Don't re-send the entry. |
| `pending_fill` | A resting (limit/stop) entry; its bracket legs attach when it fills. | Check `list_open_positions` and `list_open_orders` later. Don't re-send. |
| `not_filled` | The market entry ended without a fill (cancelled, expired or rejected, or cancelled by the server because no fill showed in time). The reply is an error: `success: false`, `errorCode: 2` (`OrderRejected`), an `errorMessage` that says whether the broker ended the entry or the server cancelled it, and the `orderId` for the record. | Nothing was opened, and a position you already had is untouched. |
| `unknown` | The stop wasn't confirmed and the flatten couldn't be confirmed either. The reply is an error whose message starts with `UNPROTECTED POSITION MAY BE OPEN`. | Call `close_position` for the contract now, then check `list_open_positions` and `list_open_orders`. Never re-send the entry. |

`filledSize`, `fillPrice`, `stopOrderId` and `targetPlaced` sit next to the status. Other things to know:

- A reply with `outcome: "unknown"` and "Unknown outcome; not re-sent" means the broker's reply to the order was lost and the order couldn't be found by its `customTag` (or more than one order carries that tag). It may or may not exist: check `list_open_orders` and `list_open_positions` before you do anything else.
- An account with `canTrade=false` refuses opening orders (`errorCode` 4, `AccountViolation`). Reducing orders go through, and so does an order on a position whose direction can't be read, since it may be an exit (the broker decides).
- If the server can't read the open positions, `place_order` fails rather than guess whether the order reduces. To get out, use `close_position`, which doesn't need that check.
- `close_position` returns `status`: `flat` (no position, no working orders on the contract), `still_open` (the position is still there or couldn't be read, including one whose direction is unknown; its orders are left in place so it keeps its stop) or `legs_left` (flat, but some orders couldn't be cancelled or checked). The last two are errors: look at `list_open_positions` and `list_open_orders` and finish the job.
- Every order tool (`place_order`, `modify_order`, `cancel_order`, `close_position`, `partial_close_position`) answers within 10 seconds. A write whose reply was lost is never re-sent: check the orders and positions.

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
  - `src/client.ts`: REST client (login, token refresh, a timeout on every request, read retries with backoff, Retry-After on 429, one re-login on 401, response envelope errors). Order writes (`Order/place`, `Order/modify`, `Order/cancel`, `Position/closeContract`, `Position/partialCloseContract`) are never re-sent once they may have reached the broker; a lost `Order/place` reply is resolved by looking the order up by its `customTag`.
  - `src/protect.ts`: bracket signing, the fill and stop check after a bracketed market entry, and the flatten (close, cancel the contract's orders, verify) used by `place_order` and `close_position`
  - `src/server.ts`: all MCP tools, the `projectx://guide` resource, and the `trading_session` prompt
  - `src/risk.ts`: guardrails and trading-day math (pure functions)
  - `src/realtime.ts`: SignalR market hub quote cache
  - `src/journal.ts`: JSONL journal
  - `src/performance.ts`: trade statistics
  - `src/http.ts`: Streamable HTTP transport
  - `src/tunnel.ts`: optional ngrok tunnel for HTTP mode
  - `src/index.ts`: entry point
- **API reference:** https://gateway.docs.projectx.com/docs/category/api-reference. `postman/ProjectX.postman_collection.json` has example requests.
- **Rules:**
  - Never write to stdout. In stdio mode stdout is the MCP protocol channel; log to stderr.
  - Every order-writing tool must call `assertTradingAllowed`. A risk-reducing order must never be refused.
  - Every order tool must answer within 10 s (`CALL_BUDGET_MS`): pass `timeoutMs`/`deadline` to every request it makes. A position is flat only when its total size is 0, whatever its direction field says. Tests drive time with `fakeClock()` from `test/helpers.ts`. Checks that add exposure go through `risk.ts`.
  - Never return or log `PROJECTX_API_KEY` or tokens. `publicConfig` is the only config the model sees.
  - Write tools get `destructiveHint: true`; read tools get `readOnlyHint: true`.
  - New tools need a test in `test/server.test.ts`, which uses an in-memory MCP client and a fake API (`test/helpers.ts`). Tests must not call the real API.
  - Tools take human-readable enum names (`buy`, `limit`, `minute`) and map them to API integers in `src/enums.ts`. Responses keep the numeric fields and add names next to them.
