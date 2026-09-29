# Stage 0 documentation research (2026-09-29)

Every fact below carries one status:

- **VERIFIED**: fetched from the official documentation during Stage 0.
- **USER-PROVIDED**: stated by the project owner as current official documentation. I did not fetch it myself because the fetch tooling failed.
- **UNVERIFIED**: from general knowledge or inference. It must be confirmed by the spike listed in [roadmap.md](roadmap.md#risks-and-spikes) before we depend on it.

Pages fetched successfully:
`docs.alpaca.markets/docs/about-market-data-api`, `/docs/real-time-stock-pricing-data`,
`/reference/stockbars`, `/docs/streaming-market-data`, `/docs/websocket-streaming`,
`/docs/paper-trading`, `/docs/orders-at-alpaca`, `/docs/authentication`.

Fetches that failed: `/reference/deleteopenposition` returned 404. A second read of `/docs/authentication` and two searches failed with tool errors. No Cloudflare page was fetched. Following your instruction, I stopped fetching.

## Alpaca: market data

| Fact                                                                                                                                                                                                | Status                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Basic plan: free, stock feed **IEX only**                                                                                                                                                           | VERIFIED                                                                                                |
| Basic: historical data since 2016, with a "latest 15 minutes" restriction (applies to SIP data)                                                                                                     | VERIFIED                                                                                                |
| Basic: **30 symbols** on the equities WebSocket                                                                                                                                                     | VERIFIED                                                                                                |
| Basic: market-data API rate limit **200 requests/min**                                                                                                                                              | VERIFIED                                                                                                |
| Algo Trader Plus: $99/mo, all US exchanges, 10,000/min                                                                                                                                              | VERIFIED (for reference only; not recommended now)                                                      |
| Historical bars: `GET https://data.alpaca.markets/v2/stocks/bars`, multi-symbol                                                                                                                     | VERIFIED                                                                                                |
| `timeframe`: `[1-59]Min`, `[1-23]Hour`, `1Day`, `1Week`, `[1,2,3,4,6,12]Month`                                                                                                                      | VERIFIED                                                                                                |
| `limit` max 10,000 (default 1,000); `page_token` pagination; `sort` asc/desc; `start`/`end` RFC-3339                                                                                                | VERIFIED                                                                                                |
| `feed`: `sip`, `iex`, `boats`, `otc`; `adjustment`: raw/split/dividend/spin-off/all                                                                                                                 | VERIFIED                                                                                                |
| Bar fields `t,o,h,l,c,v,n,vw`; `t` is RFC-3339 with nanosecond precision                                                                                                                            | VERIFIED                                                                                                |
| `t` labels the **start** of the bar, and `1Min`/`5Min`/`15Min` bars are epoch-aligned (needed for Fume's base-bar design)                                                                           | UNVERIFIED (spike S1)                                                                                   |
| Native `1Hour`/`1Day` alignment and extended-hours inclusion                                                                                                                                        | **No longer relevant**: Fume builds session-aligned 1h and RTH daily candles itself (owner decision Q5) |
| Minutes with no IEX trades produce **no bar** (gaps)                                                                                                                                                | UNVERIFIED (spike S1)                                                                                   |
| Whether a history request returns the in-progress (partial) bar                                                                                                                                     | UNVERIFIED (spike S1)                                                                                   |
| Stream URLs: `wss://stream.data.alpaca.markets/v2/{iex,sip,delayed_sip}`; `v1beta1/{boats,overnight}`                                                                                               | VERIFIED                                                                                                |
| Stream auth: `{"action":"auth","key":…,"secret":…}` → `[{"T":"success","msg":"authenticated"}]`; must authenticate within **10 s**                                                                  | VERIFIED                                                                                                |
| Channels: `trades`, `quotes`, `bars`, `updatedBars`, `dailyBars`, `statuses`, `lulds`, `imbalances`; `corrections` and `cancelErrors` are added automatically with trades                           | VERIFIED                                                                                                |
| Minute bars are emitted right after each minute mark. `updatedBars` are emitted after the half-minute if a late trade arrived. `dailyBars` are emitted after each minute mark once the market opens | VERIFIED                                                                                                |
| Messages arrive as JSON arrays (possibly several items per frame); msgpack is optional                                                                                                              | VERIFIED                                                                                                |
| Subscribe/unsubscribe `{"action":"subscribe","trades":["SPY"]}`; the ack is the full current subscription set                                                                                       | VERIFIED                                                                                                |
| Connections per endpoint are "limited based on the user's subscription … in many subscriptions … this limit is **1**"                                                                               | VERIFIED                                                                                                |
| Error codes: 401 not authenticated, 402 auth failed, 404 auth timeout, 405 symbol limit, **406 connection limit exceeded**, **407 slow client**, 409 insufficient subscription                      | VERIFIED                                                                                                |
| Slow clients may be disconnected without an error message                                                                                                                                           | VERIFIED                                                                                                |
| No sequence numbers, no replay, no documented heartbeat or ordering guarantee                                                                                                                       | VERIFIED (by absence in the fetched pages)                                                              |
| Whether the connection limit applies per API key or per account                                                                                                                                     | UNVERIFIED (spike S2)                                                                                   |

## Alpaca: trading

| Fact                                                                                                                                                                                                                                      | Status                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Paper trading API `https://paper-api.alpaca.markets`, live `https://api.alpaca.markets`, data `https://data.alpaca.markets`                                                                                                               | VERIFIED (auth page) + USER-PROVIDED                                        |
| Paper and live keys are different                                                                                                                                                                                                         | VERIFIED + USER-PROVIDED                                                    |
| HTTP auth headers `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` are documented for the Trading API and Market Data API. Stream auth uses the same key/secret in the `auth` message. **This is the method Fume uses**                        | VERIFIED + USER-PROVIDED                                                    |
| Deprecation of these headers for the Trading API                                                                                                                                                                                          | **Not established.** See the correction note below                          |
| `GET /v2/account`, `GET/POST /v2/orders`, `DELETE /v2/positions/{symbol_or_asset_id}`                                                                                                                                                     | USER-PROVIDED                                                               |
| `DELETE /v2/orders/{id}` (cancel), `GET /v2/orders:by_client_order_id`, `GET /v2/positions/{symbol}`, `GET /v2/account/activities` (FILL), `GET /v2/clock`, `/v2/calendar`, `GET /v2/assets/{symbol}`                                     | UNVERIFIED (spikes S5, S6)                                                  |
| Exact response schemas for account, order and position                                                                                                                                                                                    | UNVERIFIED. The adapter is built against captured real responses (spike S5) |
| Trading API rate limit                                                                                                                                                                                                                    | UNVERIFIED                                                                  |
| Order types: market, limit, stop, stop_limit, trailing_stop. TIF: day, gtc (90-day expiry), opg, cls, ioc, fok                                                                                                                            | VERIFIED                                                                    |
| Extended hours requires `extended_hours:true`, type `limit`, TIF `day`/`gtc`. Windows: 4:00–9:30 pre, 16:00–20:00 post, 20:00–4:00 overnight (ET)                                                                                         | VERIFIED                                                                    |
| Non-extended-hours orders submitted after 16:00 ET are **queued until the next trading day**                                                                                                                                              | VERIFIED                                                                    |
| Buying power is reserved on submission. Short order value = MAX(limit, 3% above ask) × qty                                                                                                                                                | VERIFIED                                                                    |
| Order statuses: new, partially_filled, filled, done_for_day, canceled, expired, replaced, pending_cancel, pending_replace, accepted, pending_new, accepted_for_bidding, stopped, rejected, suspended, calculated                          | VERIFIED                                                                    |
| Trade stream: paper `wss://paper-api.alpaca.markets/stream`, live `wss://api.alpaca.markets/stream`. Auth `{"action":"auth",…}`, then `{"action":"listen","data":{"streams":["trade_updates"]}}`                                          | VERIFIED                                                                    |
| The paper trade stream uses **binary WebSocket frames**                                                                                                                                                                                   | VERIFIED                                                                    |
| trade_updates events: new, fill, partial_fill, canceled, expired, done_for_day, replaced, accepted, rejected, pending_new, stopped, pending_cancel, pending_replace, calculated, suspended, order_replace_rejected, order_cancel_rejected | VERIFIED                                                                    |
| Fill events carry `timestamp`, `price`, `qty`, `position_qty`, `execution_id`                                                                                                                                                             | VERIFIED                                                                    |
| No documented delivery guarantee or replay for trade_updates                                                                                                                                                                              | VERIFIED (by absence)                                                       |
| Paper fills: only when marketable, **against the NBBO** (not IEX); order size is not checked against NBBO size; random partial fills about 10% of the time; no slippage or market impact; short selling and extended hours are supported  | VERIFIED                                                                    |

## Cloudflare

| Fact                                                                                                                                           | Status                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Workers serve HTTP and WebSocket endpoints                                                                                                     | USER-PROVIDED                                    |
| Durable Objects support long-lived WebSocket coordination                                                                                      | USER-PROVIDED                                    |
| **Durable Objects can act as outbound WebSocket clients**                                                                                      | USER-PROVIDED                                    |
| **Durable Objects are available on Workers Free using SQLite-backed storage**                                                                  | USER-PROVIDED                                    |
| WebSocket Hibernation applies only when the DO is the WebSocket **server**; outbound WebSockets do not hibernate                               | USER-PROVIDED                                    |
| **An active outbound WebSocket keeps the DO non-hibernatable, so it can incur duration usage**                                                 | USER-PROVIDED                                    |
| Free-plan DO duration allowance, overage pricing, and eviction behavior while an outbound socket is open                                       | UNVERIFIED (spike S3 cost/lifecycle run)         |
| Static frontend assets are served through the Workers assets configuration                                                                     | USER-PROVIDED                                    |
| Wrangler is the standard config/deploy tool. Credentials go in Secrets                                                                         | USER-PROVIDED                                    |
| Local dev secrets go in `.dev.vars`                                                                                                            | UNVERIFIED (common practice; confirm in Stage 4) |
| The exact outbound-socket API (`new WebSocket(url)` vs `fetch` with `Upgrade: websocket`), and reading Alpaca's **binary** trade-stream frames | UNVERIFIED (spike S3)                            |
| A client WebSocket to a Worker has no wall-clock limit while connected. DO CPU limits are per event                                            | UNVERIFIED                                       |
| Cloudflare Access can protect a Worker's custom domain, including WebSocket upgrades                                                           | UNVERIFIED (spike S7)                            |
| `Intl.DateTimeFormat` with IANA time zones works in the Workers runtime                                                                        | UNVERIFIED (spike S3)                            |
| `@cloudflare/vite-plugin` and `@cloudflare/vitest-pool-workers` are the current dev/test tooling                                               | UNVERIFIED (confirm when first installed)        |

Tooling observed locally: `npx wrangler --version` returned **4.143.1**.

npm registry and toolchain probe (2026-09-29; results and decisions in [ARCHITECTURE.md §9.2](../ARCHITECTURE.md)):

- `typescript` latest is 7.0.2.
- `vite` 8.3.1, `vitest` 5.0.2 (4.1.11 on the `V4` tag), `wrangler` 4.143.1, `@vitejs/plugin-react` 6.1.1, `@cloudflare/vite-plugin` 1.62.1, `@cloudflare/workers-types` 5.20260929.1.
- `@cloudflare/vitest-pool-workers` 0.22.0 declares the peer `vitest ^4.1.0`: **VERIFIED** (npm metadata).

## Correction note: Alpaca authentication (Stage 0 revision)

The first Stage 0 draft described the `APCA-API-*` headers as "legacy" and possibly deprecated. That was wrong to report. The word came from the fetch tool's automated summary of `/docs/authentication`, the follow-up fetch to confirm the context failed, and no deprecation statement for the Trading API was verified. The current Trading API and Market Data documentation still documents these credentials. **Fume uses `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`.** We'd revisit only if official Trading API documentation explicitly deprecates them. The adapter keeps auth in one function, which is ordinary hygiene, not a hedge against deprecation.

## Owner answers affecting research

- Q2: the Replit platform does **not** use this Alpaca account's market-data WebSocket. The 1-connection risk remains only between Fume instances (local `wrangler dev` vs deployed, or several tabs without a hub).
- Q4/Q5: regular hours by default, with session-aligned candles built by Fume. Alpaca's `dailyBars` stream and native `1Hour`/`1Day` history are therefore **not used**. Only `1Min`/`5Min`/`15Min` base bars (after S1) plus `trades`/`bars`/`updatedBars` are needed.

## Conflicts with the Stage 0 brief

1. **No conflict found on the Basic/IEX assumptions.** The brief matches the docs.
2. **The single-connection limit clashes with "browser connects to backend, backend connects to Alpaca" if each browser tab gets its own upstream connection.** A second tab, a refresh race, or local dev running next to a deployed instance would hit error 406. The proposed correction is one shared upstream connection owner. That's the conditional Durable Objects decision in [ARCHITECTURE.md](../ARCHITECTURE.md) §6, which has a single-tab fallback.
3. **Paper fills are simulated against the NBBO, but the chart shows IEX.** An execution marker can sit outside the visible candle's high/low. That is expected and not a Fume bug.
4. **Market orders placed outside regular hours are queued, not filled.** The UI must show them as pending.
