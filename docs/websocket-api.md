# WebSocket contract, v1

**Implemented (Stage 5, futures feed):** `GET /api/v1/stream?key=<opaque stream key>` with
`Upgrade: websocket`. The key comes from `/instruments/resolve` (`stream.key`); it selects the
provider/feed-scoped hub (ARCHITECTURE §6.1). Implemented frames: `hello`, `subscribe`
(`streams: ["market"]` only), `unsubscribe`, `ping` / `welcome`, `subscribed`, `unsubscribed`,
`market`, `status`, `resync`, `pong`, `error`. Not implemented yet: the `trading` stream and its
frames. Details specific to the implementation:

- **Aggregate feeds.** The delayed futures feed has no trades: `market` carries
  `bar` events with `interval: "1s"` (`phase: "provisional"`, the provider's per-second aggregate)
  and `interval: "1m"` (`phase: "final"`, the authoritative minute). The client folds seconds into
  the provisional minute and lets the minute replace it (docs/market-data.md).
- **Hub reconciliation.** After every upstream reconnect the hub sends the last 30 min of completed
  1-minute bars (REST) as `1m final` events. If that fails it sends `resync` instead.
- **`seq`.** Per connection, +1 per frame from 1. A hub restart starts again at 1: the client treats
  any other value (gap or restart) as a resync trigger.
- **`status.market`** is a core `StreamState` with provider-neutral error fields only
  (`code`, `message`, `retryable`, `reason`); e.g. `reason: "connection_conflict"` while a
  single-connection feed is held by another process.
- Errors: `invalid_request`, `unsupported_protocol` (then close 1002), `not_found` (instrument not
  served by this stream), `symbol_limit` (10 subscriptions per connection), `unavailable`.

The rest of this document is the original v1 design; where it differs, the notes above win.

Endpoint: `wss://<host>/api/v1/stream`. The upgrade requires the same authentication as HTTP, and its `Origin` must be in `FUME_ALLOWED_ORIGINS` (see [security.md](security.md)). The Worker forwards the socket to the stream hub (the `StreamHub` DO, or the per-connection relay fallback; see ARCHITECTURE §6).

All frames are JSON text. Every server→client frame has `seq`, a per-connection counter that increases by exactly 1 starting at 1. **A gap in `seq` means the client must resync.**

Timestamps inside events are `EventTime { ns, ms }`. `ns` is the canonical nanosecond epoch as a decimal string and is used for ordering. `ms` is derived and used for rendering. See [domain-model.md](domain-model.md#timestamps).

## Client → server

| Message                                                                                              | Purpose                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "type": "hello", "protocol": 1 }`                                                                 | First frame. The server answers `welcome`, or `error` + close if the protocol is unsupported.                                                                              |
| `{ "type": "subscribe", "subId": "c1", "instrumentId": "eq:SPY", "streams": ["market", "trading"] }` | Idempotent per `subId`. `market` delivers the normalized live market events below for the instrument. `trading` delivers order/fill events and account/position snapshots. |
| `{ "type": "unsubscribe", "subId": "c1" }`                                                           | Symbol switch = unsubscribe the old + subscribe the new.                                                                                                                   |
| `{ "type": "ping", "t": 1790000000000 }`                                                             | Client heartbeat, every 15 s.                                                                                                                                              |

Neither the timeframe nor the session mode is part of the subscription. The market stream is **trade-level** (every trade, in every session), plus 1m bar events. The client builds the canonical, session-aligned candle for the displayed timeframe with `@fume/core`, and in `regular` mode (the MVP default) it ignores events outside regular-session windows. Switching timeframe or session mode therefore needs only a new history fetch.

## Server → client

| `type`             | Payload                                                                                   | Notes                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcome`          | `{ protocol, serverTime, connectionId, feed: DataFeedInfo, tradingEnvironment: "paper" }` |                                                                                                                                                                                                                                                       |
| `subscribed`       | `{ subId }`                                                                               | Sent after the upstream provider acknowledges the subscription (or immediately if already subscribed).                                                                                                                                                |
| `market`           | `{ events: MarketEvent[] }`                                                               | **The live market contract.** It's a batch of normalized events (`MarketEvent` in `packages/core/src/market-data.ts`), in hub arrival order. Batching only groups events that arrived together, and the hub never holds a trade back to fill a batch. |
| `tradingEvent`     | `{ event: TradingEvent }`                                                                 | Order lifecycle, including each partial fill, forwarded as soon as the broker streams it.                                                                                                                                                             |
| `accountSnapshot`  | `{ account: Account }`                                                                    | Authoritative, from a broker REST fetch the hub makes after trading events (debounced).                                                                                                                                                               |
| `positionSnapshot` | `{ instrumentId, position: Position \| null }`                                            | Authoritative, same trigger.                                                                                                                                                                                                                          |
| `status`           | `{ market: StreamState, trading: StreamState }`                                           | Upstream health, for the UI indicator.                                                                                                                                                                                                                |
| `resync`           | `{ scope: "market" \| "trading" \| "all", reason }`                                       | The client must re-fetch the history tail and/or trading snapshot. Sent after every upstream reconnect and on hub restart.                                                                                                                            |
| `pong`             | `{ t, serverTime }`                                                                       |                                                                                                                                                                                                                                                       |
| `error`            | `{ code, message, subId? }`                                                               | E.g. `symbol_limit`, `insufficient_entitlement`.                                                                                                                                                                                                      |

### `MarketEvent` kinds (normalized, provider-neutral)

| `kind`                        | Payload                                                                                        | Role in the chart                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trade`                       | `{ trade: Trade }` (`time`, `price`, `size`, `tradeId?`, `venue?`, `conditions?`, `ingestSeq`) | **Drives the active candle.** Every trade updates the current bar of _whatever timeframe is displayed_ (1m, 5m, 15m, 1h or 1d) immediately.                                                                           |
| `bar`, `phase: "provisional"` | `{ instrumentId, interval: "1m" \| "session", bar }`                                           | Current/forming bar published by a provider whose bars match Fume's session rules (e.g. in-progress minute bars). Not emitted by the Alpaca adapter in the MVP: Fume builds the daily candle itself (market-data.md). |
| `bar`, `phase: "final"`       | same                                                                                           | Official completed bar (Alpaca: `bars`). Used for **reconciliation**: it replaces the trade-built provisional minute.                                                                                                 |
| `bar`, `phase: "revised"`     | same                                                                                           | Correction of a published final bar (Alpaca: `updatedBars`). Replaces it (`revision` + 1).                                                                                                                            |
| `instrument_status`           | `{ instrumentId, status: "trading" \| "halted" \| "unknown", time, reason? }`                  | Halt indicator.                                                                                                                                                                                                       |
| `stream_status`               | `{ state: StreamState }`                                                                       | Upstream market-data health, in-band with the data.                                                                                                                                                                   |
| `resync_required`             | `{ instrumentId?, reason }`                                                                    | In-band marker: data may be missing, so rebuild the tail.                                                                                                                                                             |

The official minute bar is **never** the mechanism that moves the active candle forward during the minute. It only reconciles. A provider that has no trade feed can drive the active candle with `bar/provisional` events, and consumers handle both. The aggregation rules are in [market-data.md](market-data.md).

**Throughput.** SPY on IEX is well within a browser's capacity at one event per trade. If profiling ever shows otherwise, the fallback is lossless **conflation**: the hub merges consecutive trades of one instrument within the same minute into a single `trade`-equivalent micro-aggregate (first/high/low/last price, Σ size, count, first/last `time`). That preserves OHLCV exactly. It's not built unless measured to be needed.

## Delivery semantics (explicitly weak)

- **At-most-once and not replayable.** Neither Alpaca stream offers replay or sequence numbers (VERIFIED by absence), and Fume doesn't invent them. `seq` detects gaps only on the Fume hop.
- Correctness therefore comes from **snapshot + events + resync**, never from assuming the event stream is complete. See [trading-state.md](trading-state.md) and [market-data.md](market-data.md).

## Liveness

- The client sends `ping` every 15 s. If there's no server frame for 30 s, the client closes and reconnects.
- On reconnect the client waits with bounded exponential backoff and full jitter: 0.5 s, 1 s, 2 s … capped at 30 s, reset after 60 s stable. It resends `hello` + all subscriptions, then performs the resync procedure.
- Upstream stale detection happens in the hub. During market hours, if no upstream frame arrives for about 60 s while subscribed to a liquid instrument, it reconnects. The exact threshold is tuned in Stage 8, because Alpaca documents no heartbeat.
