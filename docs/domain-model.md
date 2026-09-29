# Domain model and provider ports

The source of truth is the type-checked code in [`packages/core/src`](../packages/core/src). This page explains the rules those types encode.

| Concept                                                        | Type                                      | File             |
| -------------------------------------------------------------- | ----------------------------------------- | ---------------- |
| Instrument (+ session, tick rules, price format, futures spec) | `Instrument`                              | `instrument.ts`  |
| Bar / candle                                                   | `Bar`, `BarSeriesMeta`, `Timeframe`       | `market-data.ts` |
| Trade, Quote                                                   | `Trade`, `Quote`                          | `market-data.ts` |
| Market session (resolved day)                                  | `MarketSession`                           | `market-data.ts` |
| Market subscription                                            | `MarketSubscription`                      | `market-data.ts` |
| Data entitlement                                               | `DataFeedInfo`                            | `market-data.ts` |
| Account, Position, Order, Fill                                 | `Account`, `Position`, `Order`, `Fill`    | `trading.ts`     |
| Order request                                                  | `OrderRequest`                            | `trading.ts`     |
| Trading event                                                  | `TradingEvent`                            | `trading.ts`     |
| Trading snapshot                                               | `TradingSnapshot`                         | `trading.ts`     |
| Provider ports                                                 | `MarketDataProvider`, `BrokerageProvider` | `providers.ts`   |

## Rules

1. **Time.** See [Timestamps](#timestamps) below. Time zones appear only in formatting and session and bucket computation, and always come from `Instrument.session.timezone`.
2. **Numbers.**
   - Market data (`Bar`, `Trade`, `Quote`) uses `number`. It feeds rendering and aggregation, where float64 is fine.
   - Brokerage money and quantities use `Decimal` strings, exactly as the broker reports them. Order requests are built from strings, so a float never rounds `187.1` into `187.09999`. Numbers derived for display (P&L) are computed in float and labeled as estimates.
3. **Instrument identity.** `InstrumentId` is opaque and issued by the backend (e.g. `eq:SPY`). Provider symbols live only in `marketDataRef` / `brokerageRef` and are used only by adapters.
4. **Bars.** Display candles are **canonical and session-aligned**: anchored at the session window start, clipped at its end, and built by Fume from provider base bars and trades, never taken from a provider's native 1h/1d. `start` is the inclusive bucket start. `status` is `provisional` (still forming) or `final` (the bucket has ended and all inputs are provider-final). `revision` increases whenever a bar with the same `start` is replaced. Series-level metadata (instrument, timeframe, `sessionMode`, feed) isn't repeated per bar. Provider ports serve only epoch-aligned **base** intervals (`nativeIntervalsMinutes`, `BarPageRequest.intervalMinutes`). See [market-data.md](market-data.md).
5. **Session mode.** `SessionMode = 'regular' | 'extended'`. MVP default and only enabled mode: `regular`. "Regular" is defined by the instrument's session windows, never by hardcoded equity hours.
6. **Feed transparency.** Every bar series carries `DataFeedInfo` (`feedId: "iex"`, `consolidated: false`), so the UI can label the data source. Differences from SIP-based platforms are then attributable to the feed.
7. **Orders.** `quantity` and `filledQuantity` are separate. **Accepted never means filled.** `TERMINAL_ORDER_STATUSES` never transition further. `OrderType` is limited to `market | limit`, `TimeInForce` to `day | gtc`, and `OrderRequest.extendedHours` to the literal `false` for the MVP (owner decision Q6).
8. **Fills** are per execution (`executionId`). A partially filled order has several fills, and each is its own chart marker.
9. **Position.** `quantity` is absolute and direction is in `side`. Broker-computed market value and P&L are kept for reference. Fume's real-time P&L is `(last − avgEntry) × qty × multiplier × (side = long ? 1 : −1)`, computed on the chart's last price.
10. **TradingEvent** includes the Fume-generated `resync_required`. The broker offers no replay, so any possible gap tells consumers to re-snapshot instead of guessing.
11. **Live market events** are the `MarketEvent` union (`trade`, `quote`, `bar` with `phase: provisional | final | revised` and `interval: 1m | session`, `instrument_status`, `stream_status`, `resync_required`). It's both the provider-port output and the WebSocket payload. See [websocket-api.md](websocket-api.md).
12. **Provenance of trading state.** `Sourced<T>` marks each client-side trading value as `stream` (reported by the broker in a streamed event), `derived` (computed by Fume from streamed events, e.g. average entry and the P&L computed from it) or `snapshot` (authoritative broker REST). `stream` and `derived` values are `provisional: true` until a snapshot replaces them. `PositionProjection` tracks this per field. See [trading-state.md](trading-state.md).
13. **Sessions** are resolved per trading day as `MarketSession.windows[]`. That allows several windows per session, midnight crossings and scheduled breaks, which feeds the session-aware time axis (ARCHITECTURE §4.1).

## Timestamps

**Decision:** the canonical timestamp of every market and trading **event** is `EventTime { ns: EpochNs; ms: UnixMs }`.

- `ns` is integer nanoseconds since the Unix epoch (UTC) as a **canonical decimal string**: no sign, no leading zeros, no fraction. For example, `"1790000000123456789"`.
- `ms` is derived: `floor(ns / 1e6)`. It's used for rendering, bucket assignment and display only.

**Rationale:**

| Option                             | Verdict                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number` of ns                     | **Rejected.** Epoch ns (~1.8e18) exceeds `Number.MAX_SAFE_INTEGER` (~9.0e15). float64 would round silently and break ordering and de-duplication.                                                                            |
| `number` of ms only                | **Rejected.** It loses the sub-ms precision providers send (Alpaca: RFC-3339 with ns), so distinct trades would collide in ordering.                                                                                         |
| `bigint` of ns                     | Exact, but **not JSON-serializable**. Every wire and storage boundary would need custom encoding.                                                                                                                            |
| **Canonical decimal string of ns** | **Chosen.** Exact, JSON-safe, human-readable. Ordering needs no parsing: compare length, then lexicographically (valid because the form is canonical and non-negative). `BigInt(ns)` is available when arithmetic is needed. |
| `{ ms, nsWithinMs }` integer pair  | Viable, but two fields to keep consistent in every comparison. The string is simpler to compare and de-duplicate.                                                                                                            |

**Rules:**

- **Adapters** parse provider timestamps textually (never via `Date` or float) into `ns`. Lower precision (µs, ms) is zero-extended.
- **Ordering key** for trades is `(time.ns, ingestSeq)`. `ingestSeq` is assigned on arrival at the hub and only breaks exact ties.
- **Bar keys stay `UnixMs`:** bucket starts are whole-second boundaries, so ms is exact. Bucket assignment from `time.ms` is exact for the same reason.
- `Account.asOf`, `Position.asOf` and `Sourced.receivedAt` are local bookkeeping times in `UnixMs`, not event times.
- Stage 1/3 adds tested helpers in `@fume/core`: `parseRfc3339ToEpochNs`, `compareEpochNs`, `epochNsToMs`.

## Provider port design choices

- **Declarative subscriptions** (`MarketStream.setSubscriptions(desired)`). The adapter diffs against the acknowledged set and re-applies everything after reconnect, so resubscription can't be forgotten.
- **Commands resolve on broker acceptance, not on completion.** `submitOrder`, `cancelOrder` and `closePosition` return broker-confirmed request state. Fills and cancels arrive later as `TradingEvent`s.
- **Errors** cross the boundary only as `ProviderError { code, retryable, retryAfterMs }`. The raw provider code is kept for logs only.
- **`StreamState`** is part of the port (as `stream_status` events on the market stream), so the UI can show "reconnecting" honestly.
- **One event channel.** `MarketStreamHandlers.onEvents(events)` delivers the `MarketEvent` union in arrival order. A bars-only provider emits provisional `bar` events instead of `trade` events, and the aggregator accepts both.
- The ports take `Instrument` (not a raw symbol), so a futures adapter receives contract metadata without widening the interface.
