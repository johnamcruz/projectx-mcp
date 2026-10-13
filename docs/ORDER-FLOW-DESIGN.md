# Order flow: the live field contract

This document says exactly how projectx-mcp computes order flow from the TopstepX / ProjectX market hub, field by field. **projectx-mcp is the live data and the reference.** backtester-mcp reproduces these fields from local historical data (MarketTick NQ L1/L2 parquet); where history lacks something live has, approximating it is backtester-mcp's job (see [What history lacks](#what-history-lacks)). Nothing here changes how live computes order flow.

Parity is checked two ways:

1. **The same field contract**: this document.
2. **The same vector files pass in both repos**: `vectors/*.json` hold hub event streams and the exact tool results today's code returns ([Golden vectors](#golden-vectors)). backtester-mcp copies the files, converts the inputs into its own pipeline, and must produce the same flow fields.

MNQ and MES bars carry the full-size contract's flow (NQ, ES); for recorded flow on them, the recorder must record `ENQ` and `EP`.

The code: `src/orderflow.ts` (pure logic), `src/flowfeed.ts` (the live feed per contract), `src/flowtools.ts` (the tools and get_bars' flow), `src/flowstore.ts` (recorded files).

## Where it sits

```
trading harness (LLM-agnostic)
   │  broker MCP interface: get_bars(includeOrderFlow), get_order_flow, get_footprint, …
   ├── projectx-mcp    live: TopstepX market hub (GatewayTrade, GatewayQuote, GatewayDepth) → this contract
   └── backtester-mcp  history: MarketTick NQ L1/L2 parquet → the same contract, checked with the same vectors
```

The harness computes no order flow itself.

## Inputs and timestamps

Three SignalR streams per contract, each item parsed defensively (bad items are skipped and counted in `coverage.live.skippedItems`):

| Stream | Payload fields used | Time used for the computation |
|---|---|---|
| `GatewayTrade` | `price` (> 0), `volume` (> 0), `type`, `timestamp` | **Exchange time**: `timestamp` |
| `GatewayDepth` | `type` (DomType), `price`, `volume` (the level size; `currentVolume` is not used), `timestamp` | **Receive time** (this machine's clock when the message arrived). `timestamp` is only checked and counted when bad. |
| `GatewayQuote` | `bestBid`, `bestAsk`, `lastPrice`, `volume` (session cumulative) | **Receive time** |

- A `timestamp` is usable when it is an ISO string with an explicit offset (`Z` or `±hh:mm`) or an epoch-ms number, and within 60 s (`MAX_CLOCK_SKEW_MS`) of the receive time. JavaScript's `Date.parse` keeps **millisecond** precision: sub-millisecond digits are truncated (`…00.1239Z` → `…00.123`). A print with an unusable timestamp is placed at its receive time and counted in `badTimestamps`.
- Minutes are **UTC**, half-open: minute `m` holds times `t` with `m ≤ t < m + 60 s` (`minuteOf(t) = floor(t / 60000) × 60000`). A row's `t` is the minute's start.
- So prints fall into minutes by exchange time, and book-derived fields (`ofiQuote`, `bookImbalance`) by receive time. Liveness, settle points, silences and the quote-volume cross-check also use receive time.

## Trade side

`bv` and `sv` come from **the exchange's trade-side flag**, `GatewayTrade.type` (`TRADE_SIDE_BY_TYPE`):

- `0`: buy aggressor (lifted the ask) → `bv`;
- `1`: sell aggressor (hit the bid) → `sv`;
- anything else, or no `type`: **no side**. The print counts in `volume`, `trades`, `vwap`, `high`, `low` and `maxPrint`, but not in `bv`, `sv`, the large-print volumes or the footprint. Its size is added to `sidelessVolume`, and its minute is incomplete.

There is no inference from quotes or ticks. (The mapping comes from the ProjectX docs and is unverified against real pushes; see the README.)

## The L2 book (live)

One book per contract, price → size per side, from `GatewayDepth` items applied in arrival order (`Book` in `src/orderflow.ts`):

- `Reset` (6) clears both sides.
- `Ask` (1), `BestAsk` (3), `NewBestAsk` (10) set the ask size at `price`; `Bid` (2), `BestBid` (4), `NewBestBid` (9) the bid size. Size 0 removes the level.
- A `BestBid`/`NewBestBid` with size > 0 at P first removes every bid above P; a `BestAsk`/`NewBestAsk` at P every ask below P.
- `Trade` (5), `Fill` (11), `Low` (7), `High` (8), `Unknown` (0) don't touch the book.
- At most 1000 levels per side; the farthest are dropped beyond that.
- The book is **valid** once a level with size > 0 arrived on each side since the last `Reset` or disconnect. It stays valid if a side later empties. A disconnect clears it.

## Per-minute fields

Each row of `get_order_flow` (and each recorded JSONL row) is one UTC minute:

| Field | Definition | Null when |
|---|---|---|
| `bv` / `sv` | Sum of `volume` of prints with flag side buy / sell | never (0) |
| `delta` | `bv − sv` | never |
| `volume` | Sum of `volume` of every print, sided or not | never |
| `trades` | Number of prints | never |
| `vwap` | Σ price×size / Σ size over every print, rounded to 10 decimals | no print |
| `high` / `low` | Highest / lowest print price | no print |
| `maxPrint` | Largest single print size | no print |
| `largeBuyVolume` / `largeSellVolume` | Volume of sided prints whose size ≥ `largePrint` (default `PROJECTX_FLOW_LARGE_PRINT`, 10; per call) | never (0) |
| `ofiTrades` | `(bv − sv) / (bv + sv)` | `bv + sv = 0` |
| `ofiQuote` | Sum of the Cont-Kukanov-Stoikov event OFI (below) of the L1 events stamped in the minute | the book had no valid, sized state at any time in the minute and no OFI event fell in it |
| `bookImbalance` | Time-weighted mean of the top-5 book imbalance (below) over the time in the minute it was defined | it was never defined during the minute |
| `badTimestamps` | Prints in the minute with an unusable exchange timestamp | never |
| `sidelessVolume` | Volume of prints with no flag side | never |
| `complete` | See [Completeness](#completeness) | never |
| `cumDelta` | Session cumulative delta through this minute (below) | see below |
| `source` | `live` or `recorded` | never |

Prints are applied once, by exchange time, in arrival order. Two kinds are never applied: a print for a minute whose verdict is already final is counted in `coverage.live.latePrints`, and a print timed before the current live interval (replayed after a reconnect) in `replayedPrints`.

### Quote OFI

After each `GatewayDepth` message is applied, if the book is valid, the L1 state is the book's best bid and best ask with their sizes (null for an empty side), stamped with the **receive time**. When it differs from the previous L1 state, its event OFI against the previous L1 state since the last reset is added to the minute of its receive time (Cont, Kukanov & Stoikov 2014, eq. 2):

```
e_n = 1{Pb_n ≥ Pb_n−1}·qb_n − 1{Pb_n ≤ Pb_n−1}·qb_n−1 − 1{Pa_n ≤ Pa_n−1}·qa_n + 1{Pa_n ≥ Pa_n−1}·qa_n−1
```

- One L1 state per depth **message**, not per item: several level changes in one message give one state.
- `e_n` is skipped (null) when either state has a null price or size, so a state with an empty side breaks the chain until two full states follow each other.
- The chain resets (no previous state) at a `Reset` item and at a disconnect.
- `GatewayQuote` prices never feed `ofiQuote`; without a valid book they only fill the L1 history of `get_top_of_book`.

### Book imbalance

After each depth message, the imbalance is `(B − A) / (B + A)`, where B and A are the summed sizes of the top 5 levels (best first) of each side of the live book; null when the book is not valid or B + A = 0. A valid book with one side empty gives ±1. The value holds from that receive time until the next depth message (or a disconnect, which makes it null) and is integrated over time, split at minute boundaries; `bookImbalance` = ∫ value dt / time defined, per minute.

### Cumulative delta

The session starts at the trading-day start, **17:00 America/Chicago** (`tradingDayStart`). `cumDelta` of minute m is Σ (bv − sv) over the session's minutes up to m, known only when every minute from the session's first minute through m is present and complete (live or recorded); from the first missing or incomplete minute on it is null for the rest of the session. `cumulativeDelta.value` in `get_order_flow` is the `cumDelta` of the latest complete row.

## Completeness

A minute is `complete` only when all of these hold (`minuteComplete`, `tradeFeedCheck`, `recordOf`):

1. **Subscribed before it:** the trade subscription was confirmed at least `FINALIZE_GRACE_MS` (2 s) before the minute started (corrected by a negative median clock skew) and stayed connected through its end.
2. **Settled:** with `graceMs` = 2 s + the positive median print delay (receive − exchange, at most 10 s more) and `settleMs` = 10 s + that delay (at most 20 s), the settle point is end + `graceMs` once a trade message arrived after that, else end + `settleMs`. Receive time must have passed it.
3. **Alive:** a hub message for the contract arrived at or after the settle point, and no gap between messages longer than 10 s (`SILENCE_LIMIT_MS`) touches [start, settle point]. A clock jump (sleep, stall) is a disconnect from the last message.
4. **The trade feed agrees with the quote feed** (quote samples bucketed by receive time): the quote's session `volume` did not rise by more than the printed volume + the allowed carry-in + max(2 contracts, 2 %). A minute with no print needs that volume known and flat (after the lag window) and no unexplained `lastPrice` change. The previous minute's shortfall may explain quote volume received within the lag window after the boundary (max(1 s, median delay), at most 5 s), one minute back, within one live interval. A contradicted minute counts in `coverage.live.tradeFeedMismatch`.
5. **Clean prints:** `badTimestamps = 0` and `sidelessVolume = 0`.

Once decided, a minute's verdict is frozen. Only complete minutes are recorded. When recorded and live rows exist for the same minute, a complete recorded row replaces an incomplete live one and a complete live row is kept (`mergeRecords`).

## Bars

### `get_bars` with `includeOrderFlow`

`includeOrderFlow: true` (default false) adds `flow` to each bar; `flowWindows` (at most 5 sizes, each 1-50 bars) adds windows. A bar `[t, t + span)` (span = `unitNumber` minutes, or ×60 for hours; other units carry no flow) gets the sum of its minute rows, the same rows `get_order_flow` returns (live merged with recorded):

| Field | Definition |
|---|---|
| `bv`, `sv`, `trades`, `volume`, `largeBuy`, `largeSell` | Sums of the minutes' `bv`, `sv`, `trades`, `volume`, `largeBuyVolume`, `largeSellVolume` |
| `delta` | `bv − sv` |
| `vwap` | Σ(minute `vwap` × minute `volume`) / Σ `volume`, rounded to 10 decimals; null with no volume |
| `ofiTrade` | `(bv − sv) / (bv + sv)`; null when 0 |
| `ofiQuote` | Sum of the minutes' `ofiQuote`; null when any minute's is null |
| `imbalance` | Mean of the minutes' non-null `bookImbalance` (each minute weighs the same); null when none |
| `complete` | Every minute of the span is present and complete |
| `windows["n"]` | `{ofiTrade, delta}` over the n spans ending with this bar (going back by span, whether or not a bar exists there): Σbv and Σsv over them. Both null unless every one of the n spans is complete. |

When `complete` is false, every other field is null.

**Micro bars carry the full-size contract's flow** (micro and mini are treated the same): the source contract is the same-expiry full-size contract, `flowSourceContract`: root `MNQ` → `ENQ` (NQ) and `MES` → `EP` (ES). Both roots are ProjectX's names in its contract ids and are **unverified** against the live contract list; an id the broker does not know is refused by the contract check and the bars get empty flow. Other contracts carry their own. `orderFlow` in the result names the source contract, the large-print threshold, the windows and the recorded read. Recorded minutes are read from the **source contract's** files, so MNQ and MES bars have recorded flow only when the recorder's `PROJECTX_FLOW_SYMBOLS` includes `ENQ` and `EP`.

**Time bound.** The flow part (the contract check, at most 2 s; the first subscribe, waited for at most 1 s, `BARS_FLOW_WAIT_MS`; the recorded read) adds at most 3 s (`BARS_FLOW_BUDGET_MS`); past that the bars come back with empty flow and a note. The `History/retrieveBars` fetch itself keeps its existing request timeouts. A first call takes a subscription slot. When flow is unavailable (no feed, a refused subscription, the contract cap, the time bound, an error reading the minutes), every bar gets empty flow and `orderFlow.note` says why; the call does not fail.

**Bar boundaries.** The code takes each bar's `t` exactly as `History/retrieveBars` returns it, as the bar's open, and assumes the bar covers the whole UTC minutes `[t, t + span)`. It imposes no alignment of its own. How ProjectX aligns minute multiples (e.g. 5-minute bars on :00, :05, …) and hour bars (top of the UTC hour, or the session's 17:00 CT start), and whether a bar is cut at a session break, is **unverified**.

### Footprint (`get_footprint`)

Bars of `barMinutes` aligned to UTC (`floor(t / barMs) × barMs`), from the minutes' volume at price (sided prints only). Per price: `bidVolume` (sell aggressor), `askVolume` (buy aggressor). `buyImbalance` when askVolume(P) ≥ ratio × bidVolume(P − 1 tick) with a non-zero denominator; `sellImbalance` when bidVolume(P) ≥ ratio × askVolume(P + 1 tick); null without a tick size. POC: the price with the most volume; a tie goes to the price nearest the bar's VWAP, then the lower price. A bar is complete only when every minute is. Prices are the contract's raw prices.

## What history lacks

backtester-mcp's job is to approximate these live behaviours from MarketTick data and to say how close it gets:

| Live | History (MarketTick NQ, 2021-05..2025-11) | What backtester-mcp has to do |
|---|---|---|
| Trade side from the exchange's flag (`type` 0/1) | No aggressor flag (L1 `type` 2 = trade) | Infer it, e.g. the quote rule against the L1 touch in force strictly before the print (≥ ask buy, ≤ bid sell), else the tick rule; measure agreement against recorded live minutes. |
| Prints by exchange time, ms precision | `ts` in µs UTC (tz-naive) | Truncate to ms before bucketing, to match. |
| Book, `ofiQuote` and `bookImbalance` by receive time | Exchange time only | Use exchange time; receive latency is not recoverable. |
| L1 state for `ofiQuote` = the live book's best levels, one per depth message | An L1 stream with every touch change (`type` 0 bid, 1 ask) | Decide whether to conflate touch changes to match the live message granularity; compare per-minute event counts with recorded live data. |
| A full price-keyed book from `GatewayDepth` DomTypes, top 5 levels | L1 touch + L2 `depth` = rank among non-empty levels behind the touch (MBP-10), add/update/remove | Keep the book keyed by price, level 1 from L1, levels behind from L2 (strictly outside the touch); take the top 5. |
| L2 always present while subscribed | An L2 gap of about 40 days (2024-08..2024-11) | `bookImbalance` null there (and `ofiQuote` too, if it is built from the book). |
| Completeness from subscription, settle, silence and the quote-volume cross-check | No subscription or quote-volume feed | Use its own coverage facts: data present, file gaps, the roll mask; keep rule 5 (no bad timestamps, no sideless volume). |
| One contract per expiry; the recorder switches at the trading-day start when the active contract changes | Continuous NQ files; the roll at 00:00 ET on roll Mondays | Mask the roll; keep the session start at 17:00 CT (18:00 ET). Files are cut at 00:00 ET: stitch them. |
| Raw prices | Possibly back-adjusted bar prices | Apply the offset to price fields only (`vwap`, `high`, `low`, footprint prices), never to volumes or OFI. |
| MNQ bars carry NQ (`ENQ`) flow; MES bars carry ES (`EP`) flow | NQ only | Use NQ flow for MNQ, as live does. |
| Flow for every contract the broker lists | No flow for any contract but NQ (no ES, so none for MES either) | Serve no flow (empty, `complete: false`) for other contracts rather than borrow NQ's. |
| Bar `t` as `History/retrieveBars` returns it; each bar covers `[t, t + span)` in whole UTC minutes (ProjectX's alignment of minute multiples and hour bars unverified) | Bars built by backtester-mcp | Build the same `t` as ProjectX for every bar size (check against recorded `get_bars` output), then sum the same minutes. |

## Golden vectors

`vectors/*.json` are generated from today's code (`npx tsx test/gen-vectors.ts`) and checked by `test/vectors.test.ts`. Regenerate them only for an approved change to the live computation.

| File | Covers |
|---|---|
| `trade-fields.json` | Flag sides (0, 1, other, missing), delta, volume, trades, vwap, high, low, maxPrint, large prints at two thresholds, ofiTrades, sideless minute incomplete, `get_trades` |
| `book-fields.json` | The L2 book rules, `ofiQuote` (CKS on depth messages), time-weighted `bookImbalance`, an empty side, `get_market_depth`, `get_top_of_book` |
| `completeness.json` | First partial minute, a silence over 10 s, a trade-feed mismatch, a bad timestamp, a late print, a disconnect with a replayed print |
| `bars-and-session.json` | Cumulative delta from the 17:00 CT session start, `get_footprint`, `get_bars` with `includeOrderFlow`: MNQ → NQ; 5-minute bars with 2- and 3-bar windows; bar `ofiQuote` and the plain mean of minute `bookImbalance` (minutes with unequal defined time); a quiet complete 1-minute bar (vwap and ofiTrade null); a window reaching before the first returned bar; hour bars |

### Format (`schema: "projectx-orderflow-vector/1"`)

```json
{
  "schema": "projectx-orderflow-vector/1",
  "name": "trade-fields",
  "description": "…",
  "env": {},
  "tickSize": 0.25,
  "steps": [
    { "at": 1791842530000, "call": { "tool": "get_order_flow", "args": { "contractId": "CON.F.US.ENQ.Z26", "minutes": 1 } }, "expect": { "…": "…" } },
    { "at": 1791842532000, "hub": "quote", "contractId": "CON.F.US.ENQ.Z26", "payload": { "lastPrice": 100, "volume": 1000, "timestamp": "…" } },
    { "at": 1791842532000, "tick": true },
    { "at": 1791842581000, "hub": "trade", "contractId": "CON.F.US.ENQ.Z26", "payload": [{ "price": 100, "volume": 12, "type": 0, "timestamp": "2026-10-12T22:03:01.000Z" }] },
    { "at": 1791842600000, "hub": "depth", "contractId": "CON.F.US.ENQ.Z26", "payload": [{ "type": 2, "price": 99.75, "volume": 10, "timestamp": "…" }] },
    { "at": 1791843020000, "hub": "down" },
    { "at": 1791843070000, "hub": "resubscribed", "kind": "trades", "contractId": "CON.F.US.ENQ.Z26" },
    { "at": 1791843080000, "restBars": [{ "t": "2026-10-12T21:55:00.000Z", "o": 100, "h": 100.5, "l": 99.75, "c": 100, "v": 1 }] }
  ]
}
```

- `at`: the receive clock (epoch ms), never decreasing. Every step happens at its `at`.
- `hub`: a market-hub push in the hub's own payload form (`trade` = GatewayTrade items, `depth` = GatewayDepth items, `quote` = one GatewayQuote), a disconnect (`down`), or a subscription confirmed again (`resubscribed`). Pushes for a contract before its first tool call are ignored, as live.
- `tick`: one maintenance pass (the feed finalizes minutes; live runs it every 5 s).
- `call`: an MCP tool call at `at`, with `expect` = the exact JSON result. The first call for a contract subscribes it, and the hub confirms each feed at once.
- `restBars`: what `History/retrieveBars` returns to `get_bars` calls from that step on (none before the first such step).
- `env`: server environment; `tickSize`: what the contract lookup returns.

How backtester-mcp uses them: replay each vector's pushes through its own conversion of the same events (trades with a side from the flag, since the vector has one; depth and quotes stamped at `at`), and compare the **flow fields** of every `expect`: the rows' fields in [Per-minute fields](#per-minute-fields), `cumulativeDelta`, footprint bars and `get_bars`' `flow`. Integers must match exactly; floats to 1e-9. `coverage.live` describes projectx-mcp's own subscription and need not be reproduced, but `complete` must match.

## Open questions

- The GatewayTrade `type` mapping, the DomType enum, the payload fields the `ENQ` and `EP` roots for NQ and ES, and ProjectX's bar alignment are unverified against real pushes and the live contract list (README, "Unverified against the live hub").
- `bookImbalance` in a bar is a plain mean of minute means; recorded rows carry no weight, so a time-weighted bar mean would need a new recorded field.
- How well inferred sides match the flag on NQ is unknown until backtester-mcp measures it on recorded live minutes.
