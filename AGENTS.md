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
2. list_accounts                → pick an account with canTrade=true and mcpTradingAllowed=true (an error here means the login returned no accounts: stop and tell the user)
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
| Prices | Must be multiples of `tickSize` (MNQ/MES tick size is 0.25, MGC 0.1). The server rounds off-grid prices onto the grid, never toward the market or to a worse fill, and reports it in `snapped` (see below). Send on-grid prices anyway: the rounding is a safety net. |
| Empty account list | `list_accounts` returning no accounts is an error ("No accounts returned for this login …"): the account is not active at the firm, or `PROJECTX_API_URL` is not the firm's gateway. Tell the user; don't trade. An empty `search_contracts` result is just `[]`: check the symbol. |
| Brackets | `stopLossBracket` / `takeProfitBracket` `ticks` are **distances** from the fill (at least 4 ticks); the server signs them by side, so send `10`, not `-10`. They work only when the account uses Auto OCO Brackets. |
| Bars | `get_bars` returns bars oldest→newest. `t` is the bar's open time in UTC. Limit: 50 requests / 30 s. Whether bars carry order flow when you don't pass `includeOrderFlow` / `flowWindows` is the server's configuration (`PROJECTX_BARS_ORDER_FLOW`, `PROJECTX_BARS_FLOW_WINDOWS`; see `get_server_config` `flow.barsOrderFlow` / `flow.barsFlowWindows`). Pass them to override, e.g. `includeOrderFlow: false`. |
| Fills | In `search_trades`, `profitAndLoss: null` (`halfTurn: true`) marks an opening fill. Realized P&L is on the closing fill. Fees are separate. |
| `canTrade=false` / errorCode 4 `AccountViolation` | The account is locked by the firm. Stop trading it. |
| errorCode 5 `OutsideTradingHours` | The market is closed. Don't retry in a loop. |
| cancel / close errors "Live accounts not supported" | These endpoints work only on simulated or evaluation accounts. |

### Tick rounding (`snapped`)

`place_order` and `modify_order` round each price onto the contract's tick grid (`tickSize` from the contract, looked up once per contract):

| Price | buy | sell |
|---|---|---|
| `stopPrice`, `trailPrice` (stop, trailing_stop) | up | down |
| `limitPrice` | down (never pay more) | up |
| `limitPrice` of a working stop-limit (`modify_order`) | up, like its stop | down, like its stop |

So a long's protective sell stop at 20999.9 goes to 20999.75 and a short's buy stop at 21000.1 to 21000.25; a buy limit at 21000.1 goes to 21000.00. A stop-limit's limit rounds the same way as its stop, so it never moves past the trigger.

- `modify_order` takes the side and type from the working order. It **never rounds `trailPrice`**: a working trailing stop may read it back as a distance, so `trailPrice` goes to the broker exactly as you send it.
- When a price changed, the result has `snapped: { stopPrice: { from: 20999.9, to: 20999.75 } }` (one entry per changed field), and the journal records it. Recompute your $ risk from the `to` price.
- If the tick size or the working order can't be read, the price goes unchanged and the broker decides.

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

### The protection check (reconcile)

While trading is enabled, the server checks **its own trades** every `PROJECTX_RECONCILE_SECONDS` (default 30, at least 5). Its own trades are the account + contract pairs that `place_order` or `modify_order` sent an order on within the window, as recorded in the journal (`order_sent` entries, written before each order is sent, and `order_placed`). The window is since the trading day started (17:00 America/Chicago) or the last 24 hours, whichever reaches further back. A position on a pair the server hasn't traded in the window is never touched. A manual position on a pair it did trade is in scope.

**A position of yours without a covering stop gets closed.** Covered means working `stop` / `trailing_stop` orders on the side opposite the position whose sizes add up to at least the whole position. A stop-limit does not count as cover. It closes a contract only when:

- the position was seen uncovered on two checks at least `PROJECTX_RECONCILE_GRACE_SECONDS` apart (default 15),
- no order was sent on that account and contract within that grace period, and
- a fresh read right before the close still shows it open and uncovered, and the journal shows no new order on it.

It then closes the position with the same flatten as `close_position`: close, cancel that contract's orders once flat, verify. Journal entries are tagged `reconcile` and `unprotected`:
- **Success:** an `exit` entry and a logged warning.
- **Flat with working orders left over:** a `note` ("flat; legs left: <ids>"). Those orders are cancelled again on later checks while the contract stays flat.
- **Failed close:** a `note` ("close failed: …"). If the broker refused it, the next try is in 5 minutes. With no reply or not flat in time, it's 1, then 2, then 5 minutes.

It never cancels orders while a position is open and never touches orders when you are flat.

What this means for you:
- Protect every position with a stop at the exchange right away; a bracketed entry does this.
- Keep stops sized to the whole position after a partial fill or an add.
- If you see a `reconcile` entry in the journal, review why the position had no stop. A "close failed" note means the position may still be open: check it.

### Order flow: L1, L2, prints, per-minute flow, footprint

Five read-only tools serve live order flow from the market hub (SignalR; there is no REST equivalent):

| Tool | What it returns |
|---|---|
| `get_top_of_book` | **L1**: best bid and best ask with sizes, last trade (price, size, aggressor side), spread in ticks, mid; each part with its time, `ageMs` and `source`. `history: n` adds the last n best bid/ask changes. |
| `get_market_depth` | **L2**: the order book, best first per side, `{price, size, cumSize}` up to `levels` (default 10, at most 200 per side), spread, imbalance over `imbalanceLevels`, the book's `ageMs`, `valid` (both sides seen since the last reset or reconnect), `partial` (one side only so far) and `snapshot` (rebuilt after a Reset). `history: n` adds the last n per-level changes (adds and pulls). |
| `get_trades` | Recent prints `{t, price, size, side}` (up to 5000 kept per contract). |
| `get_order_flow` | Per-minute rows (UTC minutes) plus the session cumulative delta and coverage. |
| `get_footprint` | Footprint bars of `barMinutes`: volume at price split by aggressor, POC, bar delta, imbalance flags. |

**Data starts when the server subscribed.** The first flow call for a contract subscribes to its trades, depth and quotes and returns what it has, which is almost nothing at first; `coverage` says where the data starts. Ask again later for history. If the owner runs the flow recorder (`PROJECTX_FLOW_DIR` set), `get_order_flow` and `get_footprint` also read its recorded minutes, and each row says `source: "recorded"` or `"live"`. `get_trades`, `get_market_depth` and `get_top_of_book` are live only. At most 6 contracts can be subscribed at once; more are refused. An unknown contract id is refused before it takes a slot.

What the per-minute fields mean:

- `bv` / `sv`: volume of buy aggressors (lifted the ask) and sell aggressors (hit the bid). `delta = bv - sv`. `volume` and `trades` count every print; `vwap`, `high`, `low`, `maxPrint` (largest single print).
- `largeBuyVolume` / `largeSellVolume`: volume of prints of at least `largePrint` contracts (default 10, per call).
- `ofiTrades = (bv - sv) / (bv + sv)`, null with no volume.
- `ofiQuote`: order-flow imbalance of the best bid/ask (Cont, Kukanov and Stoikov): bid size added or bid price up counts as buying pressure, ask size added or ask price down as selling pressure, summed over the minute. Only from a two-sided book; null when there was none in the minute.
- `bookImbalance`: (bid size - ask size) / (bid size + ask size) over the top 5 levels, time-averaged over the minute while the book had both sides. Null otherwise.
- `badTimestamps` / `sidelessVolume`: prints in the minute with an unusable timestamp, and volume with no known aggressor side. Either makes the minute incomplete.
- `complete`: all of these hold:
  - the trade subscription was confirmed at least 2 s before the minute started (in exchange time, if this machine's clock runs behind) and stayed connected through its end;
  - the minute has settled: a trade message arrived after its end plus 2 s (more when prints arrive late), or, without one, 10 s have passed (more with late prints, at most 20 s);
  - hub messages for the contract kept coming: one arrived after the settle point, and no gap between messages over 10 s touches the minute;
  - the quote feed agrees with the prints: its session volume did not rise by more than the printed volume plus max(2 contracts, 2 %), and with no print in the minute the volume is known and flat and the last price did not change. A quote update for a print just before the boundary may land in the next minute: the previous minute's shortfall (prints minus quote volume) may explain only quote volume received within the lag window after the boundary (max(1 s, the median delay), at most 5 s), one minute back and only within one live interval; a minute with no prints must then stay flat to its end. A last-price change to that print's price within the same window is accepted;
  - every print in it had a usable timestamp and a known side.

  So the first partial minute after a subscribe, the current minute, any minute touching a disconnect, a silent stretch, a sleep of the machine, or a dead trade feed while quotes still move are incomplete. A complete minute with no trades is real zero volume: the quote feed confirms nothing traded. When the market is closed nothing arrives, so those minutes are incomplete, not zero. `coverage.live.tradeFeedMismatch` counts minutes the quote feed contradicted.
- Once a minute is final its row never changes. A print that arrives later is counted in `coverage.live.latePrints`, and prints replayed after a reconnect in `replayedPrints`; neither is applied.
- `cumDelta`: the running delta since the session start (17:00 CT). It is null whenever any minute since the session start is missing or incomplete, which is the case for the whole session if the server subscribed after 17:00 CT and no recording covers it. Never fill it in yourself.

**Use a minute, or a bar, only when it is `complete`.** A footprint bar is complete only when every minute in it is. `coverage.gaps` lists the incomplete runs.

**Order flow on bars.** `get_bars` with `includeOrderFlow: true` (minute and hour bars only; default false) adds `flow` to each bar: `bv`, `sv`, `delta`, `trades`, `volume`, `vwap`, `ofiTrade`, `ofiQuote`, `imbalance` (mean of the minutes' `bookImbalance`), `largeBuy`, `largeSell`, `complete`, and `windows`: for each n in `flowWindows` (e.g. `[5]`), `ofiTrade` and `delta` over the last n bar spans. They are summed from the same minute rows `get_order_flow` returns. Every value is null unless all of the bar's minutes are complete, and a window is null unless all its bars are. MNQ and MES bars carry NQ's and ES's flow (same expiry); `orderFlow.sourceContractId` names it. The flow part adds at most 3 s; past that the bars come with empty flow and a note. The first call takes a subscription slot, so history before it exists only if the recorder wrote it. When flow is unavailable the bars still come back, with empty flow and `orderFlow.note` saying why.

Footprint imbalance: `buyImbalance` at price P when askVolume(P) >= `imbalanceRatio` (default 3) x bidVolume(P - 1 tick); `sellImbalance` when bidVolume(P) >= ratio x askVolume(P + 1 tick). A zero on the other side never flags.

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
| `get_bars` | Historical OHLCV bars; `includeOrderFlow` adds per-bar order flow |
| `get_quote` | Real-time last/bid/ask (SignalR market hub) |
| `get_top_of_book` / `get_market_depth` | L1 top of book / L2 order book, live |
| `get_trades` / `get_order_flow` / `get_footprint` | Prints, per-minute order flow, footprint bars |
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
  - `src/protect.ts`: bracket signing, the fill and stop check after a bracketed market entry, and the flatten (close, cancel the contract's orders, verify) used by `place_order`, `close_position` and the reconcile
  - `src/ticks.ts`: `snapToTick` (float-safe floor/ceil/round on the tick ratio with a 1e-9 epsilon, rounded to 10 decimals), the rounding direction per price field and side, and the per-contract tick size cache (`Contract/searchById`)
  - `src/reconcile.ts`: the REST protection check on a timer (coverage rule, own-trade scope from the journal, grace period, backoff, lock file)
  - `src/server.ts`: all MCP tools, the `projectx://guide` resource, and the `trading_session` prompt
  - `src/risk.ts`: guardrails and trading-day math (pure functions)
  - `src/realtime.ts`: the SignalR market hub (one connection): quote cache, trade/depth/quote listeners, subscriptions restored on reconnect
  - `src/orderflow.ts`: pure order-flow logic: payload parsing, the trade-side and DomType constants, the L2 `Book`, minute buckets and rows, quote OFI, completeness, cumulative delta, footprint, merging recorded and live minutes
  - `src/flowfeed.ts`: the live feed per contract (prints, L1 history, L2 book and change history, minute buckets, live intervals), the contract cap, the roll, finalized minutes
  - `src/flowtools.ts`: the five order-flow tools, and `get_bars`' opt-in order flow (`barsWithFlow`, bounded by `BARS_FLOW_BUDGET_MS`; `flowSourceContract`: MNQ → `ENQ`, MES → `EP`, roots unverified; their recorded flow needs the recorder to record `ENQ` and `EP`)
  - `src/flowstore.ts`: recorded flow files (CSV + JSONL), the deduplicating writer, bounded tail reads
  - `src/recorder.ts`: `--record-flow` mode (lock, symbols, roll, writing)
  - `src/tooling.ts`: tool result helpers shared by the tool modules
  - `docs/ORDER-FLOW-DESIGN.md`: the live order-flow field contract (the spec backtester-mcp reproduces from historical data)
  - `vectors/*.json`: golden order-flow vectors (hub events and the exact tool results), checked by `test/vectors.test.ts`, generated by `test/gen-vectors.ts`
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
  - Prices sent by `place_order` and `modify_order` go through `snapPrices`. Stops (`stopPrice`, `trailPrice`) round down for a sell and up for a buy; limits round down for a buy and up for a sell; a stop-limit's `limitPrice` rounds with its stop. `modify_order` never rounds `trailPrice`, since it may be read back as a distance. A failed tick or working-order lookup sends the price unchanged; a lookup must never block an order.
  - `place_order` and `modify_order` write an `order_sent` journal entry (accountId, contractId, `ts` from the injected clock) **before** sending, so a lost reply still counts. The send waits for it at most `NOTE_SENT_CAP_MS` (200 ms wall time); other journal writes in order tools wait at most `RECORD_CAP_MS` (500 ms). A journal failure never blocks or fails an order. `Journal.add` writes `ts` first on each line. Protection notes in `protect.ts` use the same cap (`bounded(…, RECORD_CAP_MS)` from `journal.ts`).
  - The reconcile (`src/reconcile.ts`) runs only when `tradingEnabled` and `PROJECTX_RECONCILE_SECONDS > 0`; values below 5 are raised to 5 with a stderr line.
    - **Scope:** only account + contract pairs with an `order_sent` / `order_placed` entry since `min(tradingDayStart, now - 24 h)`.
      - The journal is shared by both copies of the server (same `journalPath`).
      - It is read with `Journal.readSince`, which reads backwards from the end in chunks. A line more than 5 min older than the window counts as old, and the read stops only once a whole chunk is old or 50 old lines come in a row. `journal_read` still reads the whole file.
      - If the journal can't be read, the cycle does nothing and warns once.
      - Streaks of pairs that leave the window are dropped.
    - **Flatten conditions:** two uncovered checks `PROJECTX_RECONCILE_GRACE_SECONDS` apart; no order entry on the pair within the grace; the lock still its own; `assertTradingAllowed`; and a re-read right before the close that still shows the contract open and uncovered.
    - **Never acts on a failed read.** Each account's reads get their own deadline.
    - **Right before `flatten`:** it re-reads the journal tail for an order on the pair within the grace (skip if there is one, or if the read fails).
    - **`legs_left`:** a `note` ("flat; legs left: <ids>") with no backoff. Only legs whose cancel failed during the flatten (`failedCancelOrderIds`) are remembered, never an order first seen in its final read. They are cancelled again, by the lock holder and within the allow-list, while the contract stays flat, and forgotten once gone or once a position reopens.
    - **Failed flatten:** a `note` (not an `exit`). A definitive broker refusal (`close.success === false` with an error code) backs off 5 min; anything else steps 1, 2, then 5 min.
    - **Lock:** `reconcile.lock` next to the journal, created exclusively, holding pid, token and heartbeat. It is stale after 3x the interval or when its pid is dead. The copy without the lock doesn't read; it only tries to take the lock each cycle.
    - **Lifecycle:** cycles never overlap. `index.ts` stops the timer and releases the lock on SIGINT/SIGTERM and on exit.
    - **Hands off orders:** it must not cancel orders while a position is open or sweep orders when flat.
  - `list_accounts` and `search_contracts` return arrays on success (the caller's broker interface depends on it). No accounts is an error; an empty contract search stays `[]` with one stderr line.
  - **Order flow:**
    - Only the recorder (`--record-flow`) writes flow files; MCP servers only read them, and subscribe lazily on the first flow call (never at startup).
    - Hub callbacks never throw: payloads are parsed defensively (bad items are skipped and counted), listeners run in try/catch, and every promise from a timer or callback is caught.
    - Every buffer is bounded (`FLOW_LIMITS` in `src/flowfeed.ts`, `MAX_BOOK_LEVELS`, `TAIL_MAX_BYTES`). Keep it that way.
    - A minute is `complete` only per `minuteComplete` in `src/orderflow.ts` (live interval started `FINALIZE_GRACE_MS` before it in exchange time, settle point from `settlePoint`: a trade message after end + grace or else `RECORDER_GRACE_MS` plus the delay up to `MAX_RECORDER_GRACE_MS`, message watermark after it, no silence over `SILENCE_LIMIT_MS`), `tradeFeedCheck` (quote volume and last price agree with the prints) and `recordOf` (no bad timestamp, no sideless volume). MCP rows and recorded rows use the same rule. Once decided (`minuteDecided`) the verdict is frozen and late prints are never applied. Never loosen it: consumers rely on it to use a bar only when all its minutes are known.
    - One hub connection: `MarketHub.connect` fails fast while a connection is connecting or reconnecting and builds a new one only after `onclose`; a stale connection's events are ignored. Two connections would count every print twice.
    - Recorded files are read asynchronously and bounded: the JSONL only for the requested window, the CSV back to the session start for the cumulative delta. A partial last line is never data; the writer truncates it.
    - A flow tool answers within 10 s: the contract check takes at most `VALIDATE_MS`, the first subscribe waits at most `SUBSCRIBE_WAIT_MS`, the tick lookup `TICK_LOOKUP_MS`.
    - Tests drive the feed with `fakeFlowHub()` and `fakeClock()` from `test/helpers.ts`.
    - projectx-mcp is the reference for order flow: `docs/ORDER-FLOW-DESIGN.md` describes exactly what live computes today. A change to any order-flow field, timestamp, completeness or null rule must update that document and regenerate the vectors (`npx tsx test/gen-vectors.ts`) in the same change, and only with the owner's approval; otherwise `test/vectors.test.ts` must pass unchanged.
    - `get_bars`' `includeOrderFlow` and `flowWindows` default to `config.barsOrderFlow` (`PROJECTX_BARS_ORDER_FLOW`, default false) and `config.barsFlowWindows` (`PROJECTX_BARS_FLOW_WINDOWS`, a comma list validated in `loadConfig`, in order: digits only per trimmed item (an empty item is invalid), 1–`BARS_FLOW_WINDOW_MAX`, no duplicates, at most `BARS_FLOW_WINDOWS_MAX`; the boolean accepts only `true`/`false`, trimmed and any case. The rule and its error messages match backtester-mcp's). An explicit argument always wins, including `false` and `[]`; keep the schema fields `.optional()` and resolve with `??`. Both settings are in `publicConfig` under `flow`. The tool's descriptions stay static (no live config values), so `tools/list` never changes with env.
    - `get_bars`' order flow is built from the same minute rows as `get_order_flow` (live merged with recorded) and never fails the call: when flow is unavailable, bars get empty flow and `orderFlow.note`.
    - **Unverified against the live hub:** GatewayQuote's `volume` being the session cumulative volume (the trade-feed cross-check relies on it); the `GatewayTrade` type mapping (`TRADE_SIDE_BY_TYPE`: 0 buy, 1 sell), the DomType enum (`DOM_TYPE`), and the payload fields (`price`, `volume`, `timestamp`, `type`; depth sizes from `volume`, not `currentVolume`). They come from the ProjectX docs; check them against real pushes before relying on the sides.
  - Tools take human-readable enum names (`buy`, `limit`, `minute`) and map them to API integers in `src/enums.ts`. Responses keep the numeric fields and add names next to them.
