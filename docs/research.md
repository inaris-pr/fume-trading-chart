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

| Fact                                                                                                                                                                                                | Status                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Basic plan: free, stock feed **IEX only**                                                                                                                                                           | VERIFIED                                                                                                                       |
| Basic: historical data since 2016, with a "latest 15 minutes" restriction (applies to SIP data)                                                                                                     | VERIFIED                                                                                                                       |
| Basic: **30 symbols** on the equities WebSocket                                                                                                                                                     | VERIFIED                                                                                                                       |
| Basic: market-data API rate limit **200 requests/min**                                                                                                                                              | VERIFIED                                                                                                                       |
| Algo Trader Plus: $99/mo, all US exchanges, 10,000/min                                                                                                                                              | VERIFIED (for reference only; not recommended now)                                                                             |
| Historical bars: `GET https://data.alpaca.markets/v2/stocks/bars`, multi-symbol                                                                                                                     | VERIFIED                                                                                                                       |
| `timeframe`: `[1-59]Min`, `[1-23]Hour`, `1Day`, `1Week`, `[1,2,3,4,6,12]Month`                                                                                                                      | VERIFIED                                                                                                                       |
| `limit` max 10,000 (default 1,000); `page_token` pagination; `sort` asc/desc; `start`/`end` RFC-3339                                                                                                | VERIFIED                                                                                                                       |
| `feed`: `sip`, `iex`, `boats`, `otc`; `adjustment`: raw/split/dividend/spin-off/all                                                                                                                 | VERIFIED                                                                                                                       |
| Bar fields `t,o,h,l,c,v,n,vw`; `t` is RFC-3339 with nanosecond precision                                                                                                                            | VERIFIED                                                                                                                       |
| `t` labels the **start** of the bar, and `1Min`/`5Min`/`15Min` bars are epoch-aligned (needed for Fume's base-bar design)                                                                           | **VERIFIED by S1** for SPY IEX on 2026-09-29 and 2025-11-28 (see S1 results below)                                             |
| Native `1Hour`/`1Day` alignment and extended-hours inclusion                                                                                                                                        | **No longer relevant**: Fume builds session-aligned 1h and RTH daily candles itself (owner decision Q5)                        |
| Minutes with no IEX trades produce **no bar** (gaps)                                                                                                                                                | **OBSERVED**: no synthetic bars; SPY 2026-09-29 had no gaps (390/390); a whole session (2025-03-10) is absent from IEX history |
| Whether a history request returns the in-progress (partial) bar                                                                                                                                     | UNVERIFIED (S1 ran after the close; Fume marks any bar whose interval has not ended as provisional)                            |
| Stream URLs: `wss://stream.data.alpaca.markets/v2/{iex,sip,delayed_sip}`; `v1beta1/{boats,overnight}`                                                                                               | VERIFIED                                                                                                                       |
| Stream auth: `{"action":"auth","key":…,"secret":…}` → `[{"T":"success","msg":"authenticated"}]`; must authenticate within **10 s**                                                                  | VERIFIED                                                                                                                       |
| Channels: `trades`, `quotes`, `bars`, `updatedBars`, `dailyBars`, `statuses`, `lulds`, `imbalances`; `corrections` and `cancelErrors` are added automatically with trades                           | VERIFIED                                                                                                                       |
| Minute bars are emitted right after each minute mark. `updatedBars` are emitted after the half-minute if a late trade arrived. `dailyBars` are emitted after each minute mark once the market opens | VERIFIED                                                                                                                       |
| Messages arrive as JSON arrays (possibly several items per frame); msgpack is optional                                                                                                              | VERIFIED                                                                                                                       |
| Subscribe/unsubscribe `{"action":"subscribe","trades":["SPY"]}`; the ack is the full current subscription set                                                                                       | VERIFIED                                                                                                                       |
| Connections per endpoint are "limited based on the user's subscription … in many subscriptions … this limit is **1**"                                                                               | VERIFIED                                                                                                                       |
| Error codes: 401 not authenticated, 402 auth failed, 404 auth timeout, 405 symbol limit, **406 connection limit exceeded**, **407 slow client**, 409 insufficient subscription                      | VERIFIED (docs); 406 and 401 also **observed** in S2 on `v2/iex`                                                               |
| Slow clients may be disconnected without an error message                                                                                                                                           | VERIFIED                                                                                                                       |
| No sequence numbers, no replay, no documented heartbeat or ordering guarantee                                                                                                                       | VERIFIED (by absence in the fetched pages)                                                                                     |
| Whether the connection limit applies per API key or per account                                                                                                                                     | Still UNVERIFIED: S2 (2026-09-30) used one key pair only; see S2 results                                                       |

## Spike S1 results (2026-09-29)

Run with `pnpm s1` against real Alpaca data (`feed=iex`, `adjustment=raw`, symbol SPY). Sanitized response bodies are in `apps/worker/test/fixtures/alpaca/recorded/` (with `s1-summary.json`); synthetic error bodies for cases not triggered deliberately are in `.../synthetic/`.

| Check (completed regular session **2026-09-29**, 09:30–16:00 ET)              | Result                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Bar counts                                                                    | `1Min` **390**, `5Min` **78**, `15Min` **26** (one page each)                              |
| IEX gaps in the regular session                                               | **none** (390/390 minutes; 0 empty 5m/15m buckets)                                         |
| Epoch alignment                                                               | all bars aligned to their interval                                                         |
| `t` = bar START                                                               | 5Min/15Min bars equal the fold of 1Min `[t, t+interval)`; the end-labeled hypothesis fails |
| All bars inside `[open, close)`; first 1Min bar at 09:30; none at 16:00       | yes                                                                                        |
| Canonical 5m / 15m from 1Min vs native 5Min / 15Min                           | identical (78 / 26 candles; OHLC, volume, trade count)                                     |
| Canonical **1h** from 1Min vs from 15Min                                      | identical (7 candles: 09:30 … 15:30, last 15:30–16:00)                                     |
| Canonical **4h** from 1Min vs from 15Min                                      | identical (2 candles: 09:30, 13:30)                                                        |
| Canonical **1d** from 1Min vs from 15Min                                      | identical (1 candle)                                                                       |
| Early close **2025-11-28** (13:00): canonical 1h / 4h / 1d from 1Min vs 15Min | identical (4 / 1 / 1 candles)                                                              |
| Calendar                                                                      | early closes 2025-11-28 and 2025-12-24 at 13:00; 2025-11-27 absent                         |
| Pagination                                                                    | `next_page_token` returned; page 2 continues page 1 with no overlap                        |
| `sort=desc`                                                                   | newest first, ending at the last minute                                                    |
| Exclusive end (`end − 1 ms` inclusive)                                        | no bar at `end`                                                                            |
| Errors (real)                                                                 | invalid timeframe → 400; unknown asset → 404; recent SIP on Basic → 403                    |

**Verdict:** native `5Min` and `15Min` pass alignment, start-labeling, nesting and canonical equality; Fume declares `[1, 5, 15]`. This is one symbol on two sessions, not a universal guarantee; the adapter still rejects any bar that is not interval-aligned, and `aggregateBars` rejects any base bar that straddles a canonical boundary.

**Follow-up observations (same day, not part of S1's pass/fail):** IEX `15Min` history includes pre/post-market bars (08:00–16:15 ET on 2026-09-28; 30 bars that day); upstream pages held ~730–740 `15Min` bars (about one month) even with `limit=10000`; Alpaca IEX history has no bars for 2025-03-10 (SIP does).

## Spike S2 results (2026-09-30)

Run with `node scripts/s2-connection-limit.ts` from `apps/worker` (diagnostic only; not a stream
adapter). Endpoint `wss://stream.data.alpaca.markets/v2/iex`, **one** credential pair (the local
paper keys), subscription `trades: ["SPY"]`. Run 06:45–06:55 ET (pre-market): **no SPY trades
arrived**, so socket health was proven by control round-trips (re-sending the subscription and
receiving the `subscription` ack), not by market traffic. Two identical rounds plus two
single-purpose runs; results were identical where repeated.

| Observation (same key, same endpoint)                                       | Result                                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection #1                                                               | opened; `connected`; auth `authenticated` in 71–84 ms; subscription acked                                                                          |
| Connection #2 while #1 is authenticated                                     | the WebSocket **opens** and receives `connected`; the **auth** reply is `[{"T":"error","code":406,"msg":"connection limit exceeded"}]` in 67–79 ms |
| Connection #2 after the 406                                                 | stays open but unusable: `subscribe` → `401 not authenticated`                                                                                     |
| Connection #1 during/after #2's attempt                                     | **not affected**: stayed open; liveness re-subscribe acked in 73–229 ms                                                                            |
| Refused #2 left idle                                                        | closed by Alpaca ~9.2 s after the 406 (~10 s after connect), with **no** error frame first (client sees 1006)                                      |
| After #1 closes: new connection                                             | first attempt succeeded, 359–411 ms after #1 closed (auth 71–72 ms); no transient 406                                                              |
| After #1 closes: re-auth on the refused #2 socket (within its ~10 s window) | `authenticated` 624 ms after #1 closed (120 ms round trip); subscription acked                                                                     |
| Client-initiated `close(1000)`                                              | every such close ended as code **1006** on the Node client (no close frame observed from the server)                                               |

**What S2 proves (for this key on `v2/iex`):** the limit is enforced at **authentication** with
`406`; the **existing** connection keeps working and is **not** displaced by the newcomer ("first
connection wins"); the slot is released as soon as the holder disconnects (a replacement
succeeded within ~0.4 s, and a refused socket could re-authenticate within its auth window).

**What S2 does NOT prove:** whether the limit is per API key or per account (only one key pair
was available; distinguishing them needs a second, independently valid key pair for the same
account); whether other endpoints (`v2/sip`, `v2/delayed_sip`, `v1beta1/*`) count against the
same limit (not tested: not needed for Fume's IEX-only design and SIP is not entitled); behavior
under live market traffic; limits of the trading (`trade_updates`) stream (out of S2 scope).

**Design consequence:** a second backend process holding the IEX socket (a second tab's relay,
`wrangler dev` next to a deployment, an overlapping refresh) is refused with 406 while the first
connection keeps the slot. Stage 5 needs exactly one upstream holder, or a reconnect loop that
treats 406 as "slot busy" and retries with backoff until the holder disconnects.

## Spike S3: Durable Object gate (2026-09-30), COMPLETE: owner GO for the DO hub primitive

Owner decision and the required permanent-design constraints are recorded in ARCHITECTURE.md §6.
The temporary Cloudflare Worker `fume-s3-spike` (and its secrets) was deleted after the run; the
spike source is kept as non-production evidence in `apps/worker/spikes/s3-durable-object/`.

### S3 documentation check

All rows are **DOCUMENTED** (official Cloudflare docs fetched 2026-09-30); nothing below is
OBSERVED or MEASURED yet.

| Fact                                                                                                                                                                                                      | Source page                                                  | Effect on earlier assumptions                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Hibernation is only supported when a Durable Object acts as a WebSocket server. **Outbound WebSockets do not hibernate.**"                                                                               | durable-objects/best-practices/websockets                    | verifies the USER-PROVIDED fact (ARCHITECTURE §6)                                                                                                                 |
| "an open outbound WebSocket connection **prevents eviction for up to 15 minutes**"; lifecycle page: pending I/O and open outbound connections prevent eviction "for up to 15 minutes from when it starts" | best-practices/websockets; concepts/durable-object-lifecycle | **new, material:** an outbound socket alone may not keep the object alive beyond ~15 min; S3 must observe whether inbound frames on that socket count as activity |
| Non-hibernatable idle objects are evicted after "70-140 seconds of inactivity (no incoming requests or events)"                                                                                           | concepts/durable-object-lifecycle                            | S3 must observe the idle-client and last-client cases                                                                                                             |
| Duration is billed on "the 128 MB of memory your Durable Object is allocated"; "Calling accept() on a WebSocket in an Object will incur duration charges for the entire time the WebSocket is connected"  | durable-objects/platform/pricing                             | verifies "billable while sockets are open"                                                                                                                        |
| Workers Free: 100,000 requests/day, **13,000 GB-s/day** duration; SQLite-backed Durable Objects only                                                                                                      | platform/pricing                                             | fills the previously unknown Free allowance                                                                                                                       |
| Workers Paid: 1 million requests/month + $0.15/million; **400,000 GB-s/month** + $12.50/million GB-s                                                                                                      | platform/pricing                                             | fills the previously unknown overage price                                                                                                                        |
| Incoming WebSocket messages are billed as requests at a **20:1** ratio; outgoing messages and incoming protocol pings are free                                                                            | platform/pricing                                             | S3 cost model input                                                                                                                                               |
| CPU: 30 s per request/event by default (configurable to 5 min); "Each incoming HTTP request or WebSocket message resets the remaining available CPU time"; received WebSocket messages up to 32 MiB       | platform/limits; workers/runtime-apis/websockets             | no blocker expected for SPY trade volume                                                                                                                          |
| Outbound client: `fetch(url, { headers: { Upgrade: "websocket" } })` then `resp.webSocket.accept()`, or `new WebSocket(url)`; text frames arrive as strings, binary as Blob/ArrayBuffer (`binaryType`)    | workers/runtime-apis/websockets                              | S3 records which frame types Alpaca actually sends                                                                                                                |
| Config: `durable_objects.bindings` + `migrations: [{ tag, new_sqlite_classes }]`                                                                                                                          | durable-objects/reference/durable-objects-migrations         | used for the S3 spike config                                                                                                                                      |

**OBSERVED locally (wrangler dev / workerd, 2026-09-30 07:1x ET, pre-market so no trades):**
isolated spike `apps/worker/spikes/s3-durable-object/` (not Stage 4 code). The DO instantiated;
the outbound `fetch(Upgrade: websocket)` to `v2/iex` authenticated and subscribed; upstream live
642 and 697 ms after the first client; two clients shared **one** upstream (1 connect); a client
leaving did not affect the other; a client returning inside the 60 s idle window cancelled the
close; after 60 s without clients the upstream closed; reconnect after that got a fresh slot (no
406); a forced upstream loss recovered to live in 1,558 ms (1 s backoff) and clients received
`resync`. Frames: 9 text, 0 binary (control messages only). Every upstream close, including our
own `close(1000)`/`close(4000)`, was reported to the DO as code 1006 (matches S2 on Node).

**OBSERVED on Cloudflare (deployed temporary Worker `fume-s3-spike`, 2026-09-30):**

- 07:35 ET functional run: upstream live 927/937 ms after the first client; two clients shared
  one upstream; idle close fired exactly 60.0 s after the last client left (upstream reported
  `1006 "WebSocket disconnected without sending Close frame."`); forced loss recovered to live in
  1,105 ms, no 406.
- **Reconstruction:** after the idle close (no sockets, no timers left), the object was
  reconstructed within ~10 s (constructor #2 → #3, new instance id, in-memory counters lost). This
  matches the documented hibernation of idle objects. **A permanent hub cannot assume ordinary
  in-memory state survives reconstruction.**
- Cloudflare's tail labels ended downstream WebSocket requests "Exception Thrown"; the JSON event
  shows outcome `responseStreamDisconnected` with **no exceptions** (normal client disconnect).
- 08:07–08:13 ET pre-market watch: DO constructor #4, upstream authenticated + subscribed, one
  connect, 0 disconnects, 0 406, 299 per-second downstream summaries, **0 SPY trades**, 3 text / 0
  binary frames (control only). Alpaca's official IEX 1Min bars also show **0 SPY trades since
  04:00 ET** that morning, so the stream matched the official record (no missing events). Not
  representative of regular-session behavior.

### S3 regular-session results (deployed `fume-s3-spike`, 2026-09-30)

Isolated spike `apps/worker/spikes/s3-durable-object/` (one DO, one outbound `v2/iex` socket,
SPY trades; downstream clients get per-second COUNTS only). Trades were counted by trade
timestamp and compared with the `n` of Alpaca's official IEX 1Min bars.

**Run A: hold mode, no clients, no requests after the start (09:27:23 → read at 10:05 ET).**

- OBSERVED: live 136 ms after connect; trades flowed from the 09:30 open (26–97 per minute, all
  text frames, 0 binary). Delivery **stopped at ~09:42:01 ET**: the object was evicted **~14 m 38 s
  after the only request**; no close handler ran; the next request met a new instance.
- OBSERVED: **inbound upstream frames do NOT count as activity** for eviction: with only an
  outbound socket, the documented "up to 15 minutes" applied.
- OBSERVED: the replacement instance reconnected on the first attempt: **no 406** (eviction
  released the Alpaca slot).
- OBSERVED (completeness): 11/12 minutes identical to the official count; the 09:30 opening
  minute streamed 61 vs official 70 (−9); 724 vs 733 total.
- MEASURED: the 13:30–13:45 UTC bucket shows `activeTime` 725.5 s (to ~13:42:05), matching.

**Redeploy while the socket was held (10:07 ET).** OBSERVED: the deploy tore down the holding
instance; the next request created a new one that authenticated and subscribed on the first
attempt, **no 406**, trades resumed within seconds.

**Run B: one client W connected throughout (10:08:31 → 10:44:43 ET, ~36 min).**

- OBSERVED: **one instance for the whole run, no reconstruction; delivery continued past 15 min**
  (minutes 16–35 normal). An open downstream (accepted) WebSocket request keeps the object alive.
- OBSERVED: 1,512 trades, 1,241 text frames, **0 binary**, 0 decode errors, 0 duplicate trade
  ids, 0 406.
- OBSERVED (sharing): client X joined at minute 20 and left at 22; W and X received identical
  counts (86 and 58), one upstream connection throughout; W unaffected when X left.
- OBSERVED (forced loss, spike-only route): upstream closed 14:40:42.857, reconnect 1 s backoff,
  live 14:40:43.978 (**1.12 s**), one `resync` to W; the 14:40 minute still matched the official
  count exactly (no trades fell in the outage).
- OBSERVED (completeness): 34/35 minutes identical; 14:38 streamed 73 vs official 78 (−5) with
  no disconnect nearby; 1,506 vs 1,511 total. Streamed was **never higher** than official.
- OBSERVED (idle close): last client left 14:43:43.2; upstream closed on purpose at 14:44:43.2
  (60.0 s); the idle object was reconstructed within ~15 s, and again within ~40 s later.

**Other observations.** Every upstream close (ours or forced) surfaced as code 1006 "WebSocket
disconnected without sending Close frame." Tail shows ended downstream requests as "Exception
Thrown"; the JSON event is `responseStreamDisconnected` with no exception. The invocations
dataset counted 8 errors among 50 DO requests (not attributed; likely those disconnect
outcomes). **Consequence: a permanent hub cannot keep ordinary in-memory state across
reconstruction** (eviction after ~15 min without requests, hibernation ~10–40 s after going
idle, and every deploy).

**Unexplained (for S4):** the two shortfalls (−9 at the open, −5 at 14:38) vs the official bar
counts. Not duplicates; possibly trades included in bars but not sent on the trade stream.

**MEASURED (Cloudflare GraphQL Analytics, read-only, 2026-09-30):** `duration` = active seconds ×
0.128 GB (e.g. 900.0 s → 115.2 GB-s per fully active 15 min, i.e. **460.8 GB-s per hour** for one
open hub); inbound upstream Alpaca frames are counted as `inboundWebsocketMsgCount` (526 in Run
A's bucket vs ~535 frames seen); CPU ~0.13 s per 15 min; the whole day's spike used **~485 GB-s**
and 50 DO requests.

**CALCULATED (measured 460.8 GB-s/h × documented allowances; one hub, SPY only):**

| Hub open              | GB-s/day | GB-s/30 days | Free (13,000 GB-s/day) | Paid (400,000 GB-s/month incl.) |
| --------------------- | -------- | ------------ | ---------------------- | ------------------------------- |
| 6.5 h/day (RTH)       | ~2,995   | ~89,856      | fits (~23%)            | fits, no duration overage       |
| 16 h/day (incl. ext.) | ~7,373   | ~221,184     | fits (~57%)            | fits, no duration overage       |

Requests: observed SPY upstream frames 33–44/min → ~12.9k–17.0k frames per 6.5 h → **~645–850
billable requests/day** at 20:1 (Free 100,000/day; Paid 1 M/month incl.). Each additional
subscribed symbol adds its own frames; downstream clients add their own requests.

**CALCULATED from the documented numbers only (not measured, superseded by the table above):** one object held active
continuously uses 0.125 GB × 3,600 s = 450 GB-s per hour, so 6.5 h/day ≈ 2,925 GB-s/day
(Free allowance 13,000/day) and 16 h/day ≈ 7,200 GB-s/day. For 30 days: ≈ 87,750 and
≈ 216,000 GB-s/month (Paid includes 400,000). This assumes one object and the documented 128 MB
billing basis; S3 must confirm actual metrics.

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

## Futures-provider + multi-provider checkpoint (research 2026-09-30, corrected same day; Databento preferred pending licensing confirmation)

**OWNER DIRECTION (2026-09-30):** the corrected research is approved. **Databento is the PREFERRED
futures provider, conditional on written confirmation** that Fume's private single-user Cloudflare
backend use is permitted under Standard personal CME licensing. **Massive is the fallback** (subject
to its own written server-side-use approval). Databento is **not** locked into the production
architecture: no account, no subscription, no API key, no adapter, no code. Provider/feed-scoped
Durable Object hubs remain the preferred topology (not implemented). Next action: HANDOFF.md.

**UPDATE (later on 2026-09-30):** the owner changed the requirement to a 10-minute-delayed futures
chart and already holds Massive Futures Starter; **Databento is deferred** and Massive Starter is
evaluated first. See "Product-direction update + Massive Futures Starter capability spike" at the
end of this file.

Research and design only: no provider locked in, no account, no key, no code. Labels: **VERIFIED**
(official source read on 2026-09-30), **PROVIDER-STATED** (official provider page, not independently
checked), **THIRD-PARTY** (non-official, flagged), **UNKNOWN** (not answerable from public docs).

**Correction pass (2026-09-30, requested by the owner).** The first version of this section said
Databento costs "$199 + at least $36.50 CME". That was wrong: it applied the general CME fee
schedule and a 2023 announcement to Databento's current personal plan. The current official pricing
and licensing pages (below) show **CME personal licensing included in Standard (up to 2 devices,
"No license fees")**. Massive's section was also corrected: its terms disclose **no additional CME
fee** and are explicitly **display-only**. The recommendation changed (see the end of this section).

### Target markets (VERIFIED: CME Group contract specifications, cmegroup.com, 2026-09-30)

| Root | Market            | Venue (DCM, rulebook chapter) | Contract unit    | Tick (outright) | Globex hours (ET)                                    |
| ---- | ----------------- | ----------------------------- | ---------------- | --------------- | ---------------------------------------------------- |
| GC   | Gold              | **COMEX** (ch. 113)           | 100 troy oz      | 0.10 = $10.00   | Sun–Fri 18:00–17:00, 60-min break daily from 17:00   |
| SI   | Silver            | **COMEX** (ch. 112)           | 5,000 troy oz    | 0.005 = $25.00  | same                                                 |
| CL   | WTI Crude Oil     | **NYMEX** (ch. 200)           | 1,000 barrels    | 0.01 = $10.00   | same (stated as 17:00–16:00 CT)                      |
| NQ   | E-mini Nasdaq-100 | **CME** (ch. 359)             | $20 × Nasdaq-100 | 0.25 = $5.00    | Sun 18:00 – Fri 17:00, daily maintenance 17:00–18:00 |
| YM   | E-mini Dow ($5)   | **CBOT** (ch. 27)             | $5 × DJIA        | 1.00 = $5.00    | same                                                 |

Future-compatibility micros (VERIFIED): **MGC** Micro Gold (COMEX ch. 120, 10 oz, $1 tick);
**SIL** Micro Silver (COMEX ch. 121, 1,000 oz, $5 tick); **MCL** Micro WTI (NYMEX ch. 309, 100 bbl,
$1 tick); **MNQ** (CME ch. 361, $2 × index, $0.50 tick); **MYM** (CBOT ch. 28, $0.50 × DJIA, $0.50
tick). Listing/termination differ per product (e.g. GC monthly for 26 consecutive months, trading
terminates 12:30 CT on the third-last business day; NQ/YM quarterly, terminate 09:30 ET on the 3rd
Friday; CL terminates 3 business days before the 25th of the prior month). Recorded for
verification only; Fume must read them from an authoritative metadata source.

### Licensing: two different things

**A. Provider personal-subscriber plans (what a single private Fume user would buy).**

- **Databento Standard** (VERIFIED databento.com/pricing and docs/portal/live-data, 2026 table):
  $199/month, "**No license fees**"; licensing row "Personal use: **Up to 2 devices · License fees
  included**", "Instant approval"; Commercial use, real-time/delayed distribution and
  white-labeling are **not** in Standard (Plus/Unlimited only). The 2026 venue table for CME:
  "**Personal: Included with Standard plan (up to 2 devices)**"; "Commercial: $973/exchange";
  "$2,170 distribution + $35.40/personal user or $119.80/commercial user".
- **Massive Futures Advanced** (VERIFIED massive.com/pricing and legal/market-data-terms-of-service):
  $199/month, individual, non-pro only. The subscriber certifies CME **Non-Professional** status and
  enters the **CME Group Subscriber Addendum** with Massive; a CME non-pro may use "a maximum of two
  Order Routing Devices". **No additional exchange fee is disclosed** in Massive's pricing or terms,
  so none is assumed.

**B. CME's general fee schedule** (VERIFIED CME Group Fee List effective 2026-01-01, owner-supplied
PDF; CME Information Policies). Monthly, per DCM: non-pro top of book $1.55 (4-DCM bundle $4.65),
non-pro depth $12.10 (bundle $36.50), professional display $134.50, Non-Display Category C $363
(Basic), Category A1 $609 (Basic), User Non-Display Category A (single natural user) $457,
real-time distribution $29,280/year. These apply to direct licensees and commercial/distribution
arrangements; **they are not an add-on to the providers' personal plans above**. CME policies:
default unit of count is the **Device**; access must be controlled by an entitlement system.

**Definitions relevant to a private Cloudflare backend.**

- Databento (VERIFIED live-data guide): **Internal** = "Any use of market data within the licensed
  company or individual user's private environment"; **Personal** = "solely for a non-professional
  individual's own investment decisions, research, or educational purposes and cannot be shared or
  leveraged for profit"; **Display** = shown in human-readable form "on a terminal, screen, or other
  device internally"; **Non-display** = "processed directly by a device ... algorithmic trading ...
  internal analytics, or other non-public backend applications. Note that some venues don't
  automatically consider API use as a non-display use case ... Some venues support personal
  non-display use." Other venue rows (ICE, EEX) say "(display or non-display)"; **the CME Personal
  row does not state display or non-display.**
- Massive (VERIFIED market data terms): licence "exclusively for your personal, non-business, and
  non-commercial purposes", "you may not use the Market Data to build an application intended for use
  by end users other than you"; "any and all Market Data is **strictly for display use only**";
  prohibited: "(d) Use Market Data for **non-display use** or to create derivative works ... unless
  you are licensed to do so"; Market Data may not be transmitted "to any other computer, server,
  website ... for publication or distribution or for any business or commercial enterprise" without
  consent.

Neither provider's public documentation explicitly classifies Fume's case (one natural person, one
private app, a Durable Object that aggregates the feed server-side and shows the chart only to that
person, no redistribution). Both need **one confirmation** (see open questions). Massive's explicit
display-only / no-non-display wording makes its answer more likely to be restrictive; Databento's
"internal ... private environment" definition is closer to Fume's case, but still not explicit for
CME.

### Provider findings

**Databento.** Category A (independent vendor; direct capture at CME Aurora DC3).

- Coverage (VERIFIED datasets/GLBX.MDP3): all CME Globex futures/options/spreads on **CME, CBOT,
  NYMEX, COMEX**, 650,000+ symbols, since 2010-06-06; MDP 3.0 is the sole Globex feed → **GC, SI, CL,
  NQ, YM (and the micros) VERIFIED** via the venue mapping above.
- Standard plan contents (VERIFIED pricing page comparison table): live **L0** (OHLCV-1s/1m/1h/1d,
  Definitions, Statistics, Status) and **L1** (Trades, MBP-1, TBBO, BBO, CBBO, CMBP-1); **live L2
  (MBP-10) and L3 (MBO) not included**. History: **16+ years of L0** (bars, definitions,
  statistics, status), **1 year of L1** (this is the included **tick/trade** history), 1 month of
  L2/L3; more is **pay-as-you-go**, not included.
- Live transport (VERIFIED docs/api-reference-live): Raw API over a **regular TCP socket**,
  `glbx-mdp3.lsg.databento.com:13000`; text control lines; **CRAM** (SHA-256 of `challenge|key`,
  reply `<hex>-<last 5 chars of key>`; the key is never sent); `encoding=json` gives **JSON lines**
  (CSV not supported live); multiple subscriptions/schemas in one session; heartbeat SystemMsg
  (`heartbeat_interval_s`).
- Recovery (VERIFIED): **intraday replay of the last 24 hours** via `start` per subscription (ISO
  8601 or ns), records filtered on `ts_event`; **`REPLAY_COMPLETED` SystemMsg per schema** when caught
  up; documented exactly-once procedure (store last `ts_event` + number of records at that
  timestamp per instrument, resubscribe from the lowest, drop duplicates); for GLBX.MDP3 the
  **definition schema is replayable for the entire weekly session**; gateway restarts Saturday 02:15
  CT (and possibly mid-week).
- Trade record (VERIFIED trades schema): `ts_event` (matching engine, **ns**), `ts_recv` (capture,
  ns), `ts_in_delta`, **venue `sequence`**, `instrument_id`, **aggressor `side`**, `price` (1e-9
  fixed point), `size`, `flags` (event end, data quality), optional `ts_out`.
- Reference (VERIFIED definitions): `asset` (root), `raw_symbol`, `exchange`, `expiration`,
  `activation`, `maturity_year/month`, `min_price_increment`, **`min_price_increment_amount`**
  (tick value), `unit_of_measure(_qty)`, `currency`; no first-notice field found. Statistics (OI,
  settlement, volume) and Status (market state) schemas; **no forward schedule/holiday API found**.
- Symbology (VERIFIED): parent `GC.FUT`, raw `GCZ6`, numeric instrument_id, continuous
  `[ROOT].[c|n|v].[rank]` (calendar / open interest / volume roll, **unadjusted**).
- Limits (VERIFIED): **10 simultaneous sessions per dataset per team (Standard)**; max 5 new
  connections per second per source IP per gateway.

**Massive** (formerly Polygon.io). Category A (independent vendor).

- VERIFIED: futures **generally available since 2026-05-28**; pricing page: every futures plan
  covers "**All Futures Tickers**" on **CME, CBOT, NYMEX, COMEX** → **GC, SI, CL, NQ, YM treated as
  VERIFIED** at the plan-definition level (no per-product list was checked).
- Futures Advanced: **$199/month**, real-time, trades, top of book, WebSockets, second/minute
  aggregates, flat files, **7+ years of history** (plan wording; trades and quotes flat files per
  exchange), individual non-pro only.
- WebSocket (VERIFIED): `wss://socket.massive.com/<asset class>`, JSON, auth
  `{"action":"auth","params":"<key>"}` (key sent inside TLS), subscribe `T.<ticker>` / wildcard.
  Trade message: `sym, p, s, t` (**ms**), `q` ("increasing, unique per ticker, non-sequential");
  **no trade id, no conditions, no aggressor side**. One WebSocket connection per asset class by
  default; one connection can take all tickers.
- REST (VERIFIED): `/futures/v1/trades/{ticker}` with **ns `timestamp`, `sequence_number`,
  `report_sequence`, `channel`**, `session_end_date`, up to 50,000 per page, real-time on Advanced;
  aggregates 1 s … session (built from trades); contracts (first/last trade, settlement date, tick
  sizes, active); products (units, currency; no tick value/multiplier field seen for index futures);
  **schedules** (pre_open/open/close in UTC with holiday adjustments, from 2024-06-10); market status.
- Recovery: **no stream replay**; WS `q` cannot detect gaps (non-sequential); missed trades can be
  refetched from REST trades (ns, sequence_number). Whether WS `q` equals REST `sequence_number`
  (needed for exact boundary de-duplication) is **UNKNOWN**. Corrections/busts on the stream:
  **UNKNOWN**.

**Other candidates (unchanged conclusions).** **dxFeed**: individuals only via third-party
platforms; API is contact-sales → eliminated for a self-serve single-user project. **Tradovate**:
live funded account ≥ $1,000 + $25/month API add-on; API market data requires a CME sub-vendor ILA
(VERIFIED support article updated 2026-09-16; cost THIRD-PARTY $290–390) → execution broker
candidate. **Rithmic**: R | Protocol API (WebSocket + protobuf), conformance testing, via an FCM →
execution-first. **CQG**: individual Client APIs must run on the same machine as the desktop client
→ eliminated. **IBKR**: funded IBKR Pro account, username/password (OAuth self-service for
individuals UNKNOWN), 10 req/s, nightly reset → broker + data option with high complexity. **CME
Group WebSocket API**: JSON WebSocket, top of book conflated to 500 ms, $0.50/GB + ILA fees,
business onboarding → later commercial option only.

### Recovery after DO reconstruction, deploy, network loss or provider disconnect

| Step                            | **Databento** (documented)                                                                            | **Massive** (documented + inferred)                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| What the hub must persist       | per schema/instrument: last `ts_event` + count of records at that `ts_event` (small, DO storage)      | last trade timestamp (+ WS `q`) per contract                                                                                       |
| Reconnect                       | TCP connect, CRAM, subscribe each schema with `start = min(last ts_event)`                            | WS connect, auth, subscribe                                                                                                        |
| Missed trades                   | **replayed by the gateway** (up to 24 h), in order                                                    | refetched via REST `/futures/v1/trades` from the last timestamp; stream resumes at "now"                                           |
| Boundary / duplicates           | **exactly-once by the documented rule** (drop records < stored ts; drop the first N at the stored ts) | overlap between REST and live WS must be reconciled; exact only if WS `q` = REST `sequence_number` (UNKNOWN); WS gaps undetectable |
| "Caught up" signal              | **`REPLAY_COMPLETED`** per schema, then live records                                                  | none (REST response + first live message)                                                                                          |
| Contract metadata after restart | definitions replayable for the whole weekly session                                                   | REST contracts/products                                                                                                            |
| Live candle reconstruction      | rebuild the active candle exactly from replayed trades                                                | rebuild from REST trades (ns) + live WS (ms); boundary approximate unless `q` matches                                              |
| Deploy / eviction / 15-min rule | same procedure; nothing lost within 24 h                                                              | same REST backfill; small boundary risk                                                                                            |
| Beyond 24 h / long outage       | historical API (L1 trades: 1 year on Standard)                                                        | REST trades/aggregates (history per plan)                                                                                          |

Both still reconcile with provider historical bars for the chart (neither CME nor the providers
publish exchange-official 1-minute bars; see ARCHITECTURE §8). Databento's recovery is
**provably complete and duplicate-free within 24 hours**; Massive's is **workable but not provably
exact** from public documentation.

### Cloudflare integration

- **Massive:** Durable Object → outbound WebSocket (TLS) → JSON auth/subscribe → JSON arrays: the
  S3-proven pattern, essentially the Alpaca adapter again. Incoming frames are billed as requests
  at 20:1 (S3 measurement).
- **Databento** (VERIFIED Cloudflare docs: `connect()` from `cloudflare:sockets` works in Durable
  Objects; readable/writable streams; `secureTransport: "off"` allowed; only port 25 blocked; an open
  TCP socket keeps a DO in memory up to 15 minutes per connection, the rule already measured in S3):
  Durable Object → `connect({ hostname: "glbx-mdp3.lsg.databento.com", port: 13000 })` → read text
  greeting + `cram=` challenge → WebCrypto SHA-256 → send `auth=...|dataset=GLBX.MDP3|encoding=json
|heartbeat_interval_s=...` → read `success=1` → send subscription lines (trades, definition,
  status, statistics; `stype_in=parent|symbols=GC.FUT,...|start=<ns>`) → `start_session` → split the
  byte stream on `\n` → JSON.parse → normalize to Fume `MarketEvent`s. **No Python/C++/Rust, no SDK,
  no DBN decoder and no native module are required** for this path (the JSON encoding is
  documented for the live API). Remaining engineering: a streaming line splitter, 1e-9 price/uint64
  timestamp conversion (JSON field encoding to be confirmed in a spike), the replay de-dup state in
  DO storage, and reconnect/backoff. Estimated a moderate adapter, somewhat larger than Alpaca's.
  Risks: **plaintext TCP** (the key is protected by CRAM; the market data itself is unencrypted);
  Cloudflare's shared outbound IPs vs the 5-connections/second/IP gateway limit; whether incoming
  TCP bytes count toward DO request billing is **UNKNOWN** (they are not WebSocket messages).

### Head-to-head: Massive vs Databento (one private non-professional user)

| Aspect                         | **Massive Futures Advanced**                                                     | **Databento Standard**                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Monthly personal price         | **$199**                                                                         | **$199**                                                                                            |
| Exchange licensing             | CME Subscriber Addendum, non-pro, ≤ 2 devices; no extra fee disclosed            | CME personal **included** (≤ 2 devices), "No license fees"                                          |
| GC / SI / CL / NQ / YM         | VERIFIED (plan: all futures tickers on the 4 exchanges)                          | VERIFIED (all Globex instruments)                                                                   |
| Transport                      | WebSocket (TLS), JSON                                                            | raw TCP (no TLS documented), text control + JSON lines                                              |
| Cloudflare implementation      | trivial (S3-proven pattern)                                                      | feasible via `cloudflare:sockets`; moderate custom adapter                                          |
| Live trade timestamps          | WS **ms**; REST ns                                                               | **ns** `ts_event` + `ts_recv` (+ `ts_out`)                                                          |
| Trade identity / quality       | per-ticker `q` (non-sequential); no id, conditions or side                       | venue `sequence`, `instrument_id`, aggressor side, quality flags                                    |
| Recovery / replay              | REST backfill; boundary not provably exact                                       | **24 h replay, REPLAY_COMPLETED, documented exactly-once**                                          |
| Historical depth (included)    | 7+ years (plan wording, incl. trades flat files)                                 | 16+ years L0 bars/definitions/statistics; **1 year** L1 trades; more pay-as-you-go                  |
| Reference metadata             | contracts (dates, tick sizes), products (units), no tick value for index futures | definitions incl. **tick value**, expiration, activation, root; statistics (OI, settlement); status |
| Session / schedule metadata    | **schedules API** with holiday adjustments (from 2024-06-10)                     | status (live state) only; forward schedule needs a CME calendar source                              |
| Contract resolution            | contracts API by product code, point-in-time `date`                              | parent `ROOT.FUT`, definitions, continuous c/n/v (unadjusted)                                       |
| Connection limits              | 1 WS per asset class (all tickers)                                               | 10 sessions per dataset; 5 new conn/s/IP                                                            |
| Server-side personal licensing | ambiguous; terms are **display-only, no non-display**                            | ambiguous for CME; definitions include "individual user's private environment"                      |
| Future commercial path         | Business $999 per exchange per month (+ distribution terms)                      | Plus $1,750/month (external distribution) / Unlimited $4,500; CME commercial $973/exchange          |
| Implementation difficulty      | **low**                                                                          | **moderate**                                                                                        |

### Re-scored for Fume's priorities

| Priority (weight order)                  | Massive                           | Databento                                      | Edge                                    |
| ---------------------------------------- | --------------------------------- | ---------------------------------------------- | --------------------------------------- |
| 1. Reliable real-time trade data         | good (ms, no id/side)             | excellent (ns, venue sequence, side, flags)    | **Databento**                           |
| 2. Recovery after reconstruction/network | REST backfill, boundary inexact   | documented 24 h exactly-once replay            | **Databento**                           |
| 3. Contract/reference metadata           | good + schedules API              | excellent definitions/statistics; no schedules | Databento (slight); schedules → Massive |
| 4. Historical data                       | 7+ y incl. trades                 | 16+ y bars, 1 y trades (more pay-as-you-go)    | mixed (bars: Databento; ticks: Massive) |
| 5. Cloudflare compatibility              | proven pattern                    | feasible, custom TCP                           | Massive                                 |
| 6. Licensing clarity (private user)      | display-only terms; question open | personal CME included; question open           | Databento (slight)                      |
| 7. Price                                 | $199                              | $199                                           | tie                                     |
| 8. Implementation complexity             | low                               | moderate                                       | Massive                                 |

### Contract model (provider-neutral, conceptual; unchanged)

Root/product (tick rules, multiplier/tick value, currency, sessions) → backend contract resolution
(explicit month or a recommended active contract) → a Fume `Instrument` for **one specific
contract** (existing `FutureContractSpec`: root, contract month, expiration, last trade, first
notice, tick value), opaque contract-specific InstrumentId, no hard-coded front month. First
notice dates need a CME calendar source (not found in either provider's reviewed fields). Rollover
options (calendar, volume/OI, user-selected) stay undecided; **explicit contract + a recommended
default** is safer than a synthetic continuous series for initial support.

### Sessions (unchanged)

CME Globex: Sunday 18:00 ET open, Friday 17:00 ET close, daily 17:00–18:00 ET break; the trading day
is the day the session ends. Fume's `MarketSession` windows (crossing midnight, breaks) and
`sessionDate` already express this: **no model change needed**. Holidays/early closes need a
schedule source: Massive's schedules API or a CME holiday calendar (Databento: status only).

### Permanent hub topology (preferred topology, unchanged; not implemented)

**Option B: provider/feed-scoped Durable Object hubs** (e.g. `alpaca/iex` and
`futures/<selected-provider>`), each owning one upstream and its own subscriptions, limits,
reconstruction and resync; the browser receives an opaque stream key per instrument. Compared with
one global object (shared blast radius, mixed lifecycles) and per-client session objects (extra hops
and cost), B isolates credentials usage paths, connection limits, failures, recovery and
subscriptions, and usually keeps only one hub open (one chart = one instrument). The corrected
research does not change this; Databento's 10 sessions per dataset even leave room for a separate
replay/backfill session per hub.

### Cost model (per month, one private non-professional user)

- **Market data:** Massive **$199** or Databento **$199** (CME personal licensing included; no
  exchange fee added in either provider's current official material). If a provider ruled Fume's
  backend to be commercial or non-display use, commercial CME licensing would apply instead (e.g.
  Databento's CME commercial $973/exchange); that is the open question, not an assumed cost.
- **Cloudflare (S3 measured 460.8 GB-s per open hub-hour):** futures hub 23 h/day ≈ 10,598 GB-s/day
  (fits Free 13,000/day); futures + equities hubs both open 16 h/day ≈ 14,746 GB-s/day exceeds Free;
  on Paid, 30 days × 23 h ≈ 318k GB-s (within 400k included). Futures message rates are
  **UNKNOWN** until measured; with Databento TCP, request billing for incoming bytes is UNKNOWN.

### Open questions (require provider confirmation; not contacted)

1. **Databento (the one licensing question):** "Does a private single-user Durable Object backend,
   used only to power that same subscriber's personal chart, remain covered by Databento Standard
   personal CME licensing?"
2. **Massive (the equivalent question):** "May an eligible individual non-pro Futures Advanced
   subscriber receive the real-time futures feed in a private server-side backend (a Cloudflare
   Durable Object) that aggregates it into charts displayed only to that same person, given the
   terms' 'strictly for display use only' and non-display restrictions?"
3. Massive: "Is the WebSocket trade `q` the same value as the REST trades `sequence_number`? Are
   trade corrections/cancellations delivered on the WebSocket? Is open interest available?"
4. Databento: "How are `price` and uint64 timestamps encoded in live `encoding=json` records? Is a
   TLS endpoint available for the Raw API? Are Cloudflare's shared outbound IP ranges a problem for
   the 5-connections-per-second-per-IP limit?"
5. Both: device counting when one person uses the app on a phone and a laptop (both plans allow up
   to two devices).
6. Later (commercial platform): distribution terms and CME per-user fees (Databento Plus / Massive
   Business).

Broker-side questions (Tradovate CME sub-vendor cost; IBKR individual OAuth) only matter if a
combined broker+data provider is chosen; they are not blocking for the data decision.

### BEST TECHNICAL FIT FOR FUME

**Databento (Standard).** It wins the two highest priorities: trade data quality (nanosecond
matching-engine timestamps, venue sequence numbers, aggressor side, quality flags, direct capture)
and recovery (24-hour intraday replay with a documented exactly-once procedure and a
`REPLAY_COMPLETED` signal), which maps directly onto the S3 constraint that Durable Object state is
disposable and reconstruction must be expected. Its definitions/statistics/status schemas give the
richest contract metadata, and its personal CME licensing is explicitly included at the same $199.

### BEST SIMPLEST IMPLEMENTATION

**Massive (Futures Advanced).** Same JSON-over-WebSocket model as the Alpaca adapter and the
S3-proven hub, a schedules API for sessions and holidays, and 7+ years of history including trades,
also at $199. The cost is weaker recovery (REST backfill with an inexact boundary), millisecond
stream timestamps, fewer trade attributes, and display-only terms that make the private-backend
question sharper.

### RECOMMENDED PROVIDER FOR FUME

**Databento**, subject to one confirmation: that its Standard personal CME licensing covers a
private single-user Durable Object backend. The two labels differ because Fume is a long-term
trading platform whose correctness depends on complete, duplicate-free trade streams after every
Durable Object reconstruction, deploy and network loss; Databento's replay provides that by design,
while Massive's simplicity would have to be paid for later in reconciliation edge cases. The extra
work (a `cloudflare:sockets` + JSON-lines adapter) is moderate and needs no SDK. If Databento cannot
confirm the licensing, **Massive** is the fallback (after its own confirmation). A trading
**broker** remains a separate, later decision (Model A: data vendor + separate broker behind
`BrokerageProvider`).

**Sources (read 2026-09-30):** cmegroup.com contract specs (GC, SI, CL, NQ, YM, MGC, SIL, MCL, MNQ,
MYM); CME Group Fee List effective 2026-01-01; cmegroup.com Information Policies; CME Real-Time
Futures and Options Data API page; databento.com/pricing (incl. comparison table), docs/portal/live-data
(2026 licence table and definitions), datasets/GLBX.MDP3, Live API docs (overview, authentication,
intraday replay, system messages, connection limits, encodings, recovery, maintenance), trades
schema, instrument definitions, symbology; massive.com/pricing (futures), legal/market-data-terms-of-service,
docs (futures WebSocket trades, REST trades, contracts, products, schedules, aggregates, WebSocket
quickstart), knowledge base (WebSocket connections), blog (futures GA, professional status),
business-futures; dxfeed.com CME page; support.tradovate.com "Tradovate API Access"; rithmic.com/apis;
cqg.com/products/cqg-apis; IBKR Campus Web API documentation; developers.cloudflare.com TCP sockets
and Workers limits.

## Product-direction update + Massive Futures Starter capability spike (2026-09-30; intended futures provider, cloud blocked pending Massive licensing)

**CURRENT PROVIDER DIRECTION (owner, 2026-09-30; supersedes the Databento preference above):**

| Market                                  | Provider                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| US equities / ETFs                      | **Alpaca** (unchanged Stage 4 implementation)                    |
| Initial futures: **GC, SI, CL, NQ, YM** | **Massive Futures Starter** (intended; data ~10 minutes delayed) |
| Databento                               | **deferred** as a researched fallback, not selected              |
| Massive Stocks                          | **not needed** at this time                                      |

Reasons: Alpaca equities are already implemented and validated and provide Fume's equity/ETF data
without another paid stock-data subscription; Massive Futures Starter (already owned, $29/month) has
been locally proven sufficient for Fume's delayed futures chart; there is no architectural benefit
to removing a working provider solely to reduce the number of vendors. Real-time futures and raw
trade-level futures streaming are **not required initially**. Fume stays **provider-neutral**: the
browser contains no Alpaca- or Massive-specific chart logic, and neither provider is written into
ARCHITECTURE.md as permanent. **Cloud deployment of Massive data is BLOCKED PENDING WRITTEN MASSIVE
CONFIRMATION** (see Licensing below); local capability testing is complete. Permanent Massive
futures support is not implemented.

Spike: `apps/worker/spikes/massive-futures-starter/` (NON-PRODUCTION, local Node only, not
Cloudflare; `rest.ts`, `ws.ts`). Run 2026-09-30 17:25–17:52 UTC (13:25–13:52 ET, Globex open).
Labels: **VERIFIED** (official page read), **OBSERVED** (seen in this spike), **UNKNOWN**.

### Starter plan (VERIFIED massive.com/pricing futures tab + docs "Plan Access/Recency" tables)

$29/month, "Great for aggregates", Individual use: All Futures Tickers; Unlimited API Calls; 2 Years
Historical Data; CME, CBOT, NYMEX, COMEX; 10-minute Delayed Data; Reference Data; Minute Aggregates;
Flat Files; WebSockets; Snapshot; Second Aggregates. **Not included:** Trades and Top of Book Quotes
(Developer $79 / Advanced $199). Per-endpoint docs: aggregates REST "10-minute delayed", 2 years;
WebSocket `A` and `AM` "10-minute delayed"; snapshot "10-minute delayed"; contracts/products/schedules
"Updated daily"; market status "Updated in real time". The Starter card does not carry the
Advanced plan's "Non-pros only" tag, but the market data terms apply to all futures data (below).

OBSERVED: `/futures/v1/trades` and `/futures/v1/quotes` → **HTTP 403** "You are not entitled to this
data"; everything else above returned 200. The key was accepted by REST (Authorization: Bearer
header) and by both WebSocket hosts.

### Contract discovery (OBSERVED; no ticker hard-coded)

Products (`/futures/v1/products?product_code.any_of=…`) and contracts
(`/futures/v1/contracts?product_code=<root>&date=<today>&active=true&type=single`):

| Root | Venue (MIC)  | Contract unit (products) | Tick (contracts) | Tick value (tick × unit) | Settlement          | Nearest active contracts (last trade date)          | Recommended now (highest session volume) |
| ---- | ------------ | ------------------------ | ---------------- | ------------------------ | ------------------- | --------------------------------------------------- | ---------------------------------------- |
| GC   | COMEX (XCEC) | 100 TRYOZ                | 0.1              | $10                      | deliverable         | GCV6 (2026-10-28), GCX6 (11-25), GCZ6 (12-29), GCF7 | **GCZ6** (127k vs GCV6 781)              |
| SI   | COMEX (XCEC) | 5000 TRYOZ               | 0.005            | $25                      | deliverable         | SIV6 (10-28), SIX6 (11-25), SIZ6 (12-29), SIF7      | **SIZ6** (31.7k)                         |
| CL   | NYMEX (XNYM) | 1000 BBL                 | 0.01             | $10                      | deliverable         | CLX6 (10-20), CLZ6 (11-20), CLF7 (12-21), CLG7      | **CLX6** (172k vs CLZ6 53k)              |
| NQ   | CME (XCME)   | 20 IPNT                  | 0.25             | $5                       | financially settled | NQZ6 (12-18), NQH7, NQM7, NQU7                      | **NQZ6** (431k)                          |
| YM   | CBOT (XCBT)  | 5 IPNT                   | 1                | $5                       | financially settled | YMZ6 (12-18), YMH7, YMM7, YMU7                      | **YMZ6** (54k)                           |

- Ticker syntax: root + CME month code + **one-digit year** (`GCZ6`, `NQH7`); spreads/combos are
  `NQH7-NQM7` (`type=combo`). Tick values computed from the two endpoints match the CME
  specifications recorded above for all five.
- Contract fields: `ticker, product_code, first_trade_date, last_trade_date, settlement_date,
days_to_maturity, trade_tick_size, settlement_tick_size, spread_tick_size, trading_venue,
group_code, type, min/max_order_quantity, active, date`. **No first-notice date, no open interest,
  no multiplier field** (multiplier = products `unit_of_measure_qty`).
- Gotchas: without `date=`, `/contracts` returns **one row per contract per historical day** (from
  2018); `sort` accepts only `date|product_code|ticker`, so sort by expiry client-side. Point-in-time
  contract lookups returned results for 2025-10-01 but **0 rows for 2025-03-03 and earlier**
  (cause UNKNOWN), although aggregates exist back to ~2024-10-01.
- Snapshot (`/futures/v1/snapshot?ticker.any_of=…`): `details{ticker, settlement_date}`,
  `session{open, high, low, close, volume, settlement_price, previous_settlement, change,
change_percent}`, `last_minute`, and — although the plan excludes trades/quotes — **delayed
  `last_trade` and `last_quote` objects** (`timeframe: "DELAYED"`, ~10 min old). By
  `product_code` the snapshot pages are mostly spreads (GC/CL first page: 95–100 of 100 rows), so
  query by `ticker.any_of` instead. **Data-quality anomaly:** deferred NQ contracts (NQH8, NQU7) showed
  session prices ~6,000–7,000 against ~30,800 for NQZ6, with sizable volumes; the recommendation rule
  must restrict to near contracts and sanity-check.

**Proposed contract resolution (not implemented):** user selects a root (`NQ`) → backend lists
active single contracts for today, sorts by `last_trade_date`, snapshots the nearest ~4–6 and
recommends the one with the highest session volume (GC/SI: the active month, not the nearest
serial month; CL: rolls before `last_trade_date`) → the chart instrument is that specific contract
→ the user can choose another contract explicitly. No synthetic continuous series. First-notice
dates (GC/SI/CL are deliverable) still need a CME calendar source.

### REST aggregates (OBSERVED)

- `/futures/v1/aggs/{ticker}?resolution=1min` fields: `ticker, window_start` (**ns**),
  `session_end_date, open, high, low, close, volume, transactions, dollar_volume` (numbers).
  Resolutions 1sec, 1/5/15min, 1/4hour and 1session all returned 200 on Starter. Hour/4-hour bars
  are **UTC-clock aligned** (e.g. 16:00Z), not CME-session aligned → Fume builds higher timeframes
  from 1m itself (as planned).
- **Session-date semantics:** bars before the 16:00 CT close carry that day's `session_end_date`;
  bars from 17:00 CT (22:00Z during CDT) carry the **next** day. The one-hour maintenance break is a
  clean gap (last bar 20:59Z, next 22:00Z). This matches Fume's `sessionDate` (the ending day).
  `1session` bars are keyed by the **calendar day before** the session end at 00:00Z (not the actual
  open time) and include `settlement_price`.
- **Pagination:** `limit` up to 50,000, `next_url` cursor; one UTC day of NQZ6 1m = 1,380 bars in
  four pages of 400, ascending, 0 duplicates, the only non-60 s step = the maintenance break.
  Minutes without trades have **no bar** (documented; Fume must tolerate gaps on thin contracts).
- **1sec ↔ 1min consistency:** 59 REST 1sec bars of one minute summed exactly to the REST 1min bar
  (O, H, L, C, volume, transactions).
- **History depth:** 1m and 1session bars returned for 2024-10-01 (NQZ4); **none for 2024-09-03
  (NQU4) or 2023-10-02** → ~2 years, as advertised.
- **Observed delay:** the latest 1sec bar was consistently **600–602 s** old. The latest 1min bar
  appeared when `window_start` was 10 min old (bar end ~9 min old) and was already final: its values
  did not change on later polls, and 6 recent 1min bars re-fetched 5–6 minutes later were identical
  (**no revisions observed**).

### WebSocket (OBSERVED, local Node, `wss://delayed.massive.com/futures`)

- Connect 0.3–0.7 s; `status connected` → send `{"action":"auth","params":<key>}` →
  `status auth_success "authenticated"` (~1.1 s) → `{"action":"subscribe","params":"A.NQZ6,AM.NQZ6"}`
  → one `status success "subscribed to: …"` per channel. Comma-separated multi-ticker subscription
  worked; all five contracts × {A, AM} ran on **one connection**.
- Events: `A` (per second) and `AM` (per minute) only; no other message types seen. Fields `ev, sym,
v, n, s, e` are numbers but **`o, h, l, c, dv` arrive as JSON strings** (docs show numbers) →
  the adapter must parse them. `s`/`e` are **ms**; `A` windows are exactly 1,000 ms, `AM` 60,000 ms.
- **Delay:** arrival − window end = **603.8–605.1 s** for `A` and 604–605 s for `AM` on all five
  contracts (i.e. 10 min + ~4 s). `A` bars stream continuously (one per second with trades; e.g.
  NQZ6 ~1/s, SIZ6 ~1 per 7–8 s); **no repeated windows, no revisions**: each second and each minute
  arrives once. `AM` arrives once, ~4–5 s after the delayed minute closes.
- **Consistency:** streamed `A` bars were identical to REST 1sec bars; the sum of a full minute of
  `A` equalled `AM`, and `AM` equalled the REST 1min bar exactly (O/H/L/C/V).
- **No backfill on subscribe:** the stream starts at "now − 10 min"; seconds before the subscription
  are only in REST.
- **Reconnect:** closed, waited 20 s, reconnected: auth + resubscribe + first `A` in **1.9 s**; the
  23 s gap was **not replayed**; REST returned the 20 missing 1sec bars (recoverable).
- **Connection limit (important):** a **second connection with the same key is accepted and the
  OLDER one is dropped** with `status max_connections` ("Maximum number of websocket connections
  exceeded…") and close **1008**. Reproduced twice. This is the opposite of Alpaca (which refuses the
  new connection with 406): a local dev process and a deployed hub would silently steal the feed from
  each other.
- The real-time host `wss://socket.massive.com/futures` also accepted auth with the Starter key; no
  subscription was attempted there, so its entitlement/recency is UNKNOWN.

### Session data (OBSERVED `/futures/v1/schedules`, `/futures/v1/market-status`)

- Per product and `session_end_date`: events `pre_open`, `open`, `close` (and `pause` for some
  products) in UTC. NQ normal day: open 22:00Z previous day (17:00 CT), close 21:00Z (16:00 CT) →
  the daily break is the gap between `close` and the next `open`. **Sunday open** (session 09-28:
  open 2026-09-27T22:00Z) and **Friday close** (session 10-02: close 21:00Z) are present.
- **Holidays/early closes are present and future dates are published** (GC Thanksgiving 2026:
  session 11-27 with an extra `pre_open`/`open` on 11-26 and close 19:45Z). Holiday sessions merge
  several days into one `session_end_date` and express the halt only as a later `pre_open`/`open`
  (no explicit halt `close`), so interpreting them needs care.
- Every event was returned **2× (CL 13×)**; market status likewise repeated rows (CL ×13) → dedupe.
  History starts 2024-07-31. Market status returned `open` with the current `session_end_date`.
- Conclusion: Massive schedules can be the **primary session-calendar source** for the five roots
  (normal hours, Sunday open, Friday close, holidays, early closes), after dedupe and validation
  against the CME holiday calendar for the first releases. First-notice dates are not in it.

### Chart suitability (answer)

**Yes, Starter can support a high-quality 10-minute-delayed candlestick chart for 1m, 5m, 15m, 1h,
4h and 1d** with historical loading (REST 1m, ~2 years, paginated), incremental updates and a moving
delayed current candle (`A` per second), finalized minutes (`AM`, identical to REST), volume,
session-aware bars (`session_end_date` + schedules), left paging (REST `window_start.lt`) and
reconnect recovery (REST 1m/1sec re-fetch). Missing or limiting: no real-time data; no trades or
quotes (no tick-by-tick, no bid/ask display beyond the delayed snapshot); no open interest; no
first-notice dates; 2-year history limit; point-in-time contract reference only ~1 year back; a single
WebSocket connection per account with newest-wins eviction.

### Approved conceptual delayed-futures model (owner-approved 2026-09-30; NOT implemented)

1. **History:** REST 1m aggregates → Fume canonical 1m history (per contract; `session_end_date` →
   Fume session date).
2. **Delayed current candle:** WebSocket `A` (1 s) aggregates → provisional current 1m candle
   (O = first A open, H/L = max/min, C = last close, V = sum).
3. **Minute finalization:** WebSocket `AM` (or REST 1m) replaces the provisional minute; observed
   identical to REST, no revisions.
4. **Higher timeframes:** Fume canonical 1m → 5m / 15m / 1h / 4h / 1d with Fume's own session-aligned
   rules (Massive's hour bars are UTC-aligned and are not used).
5. The existing trade-level aggregator stays for trade feeds (Alpaca); Starter futures do not go
   through it. **Massive's aggregate bars are authoritative for initial futures support.**

**Reconnect / reconstruction recovery (evaluated):** reconnect → auth → resubscribe → REST 1m with
an overlap (e.g. last 15–30 min) → replace Fume's recent canonical minutes → resume `A` into the
current minute (optionally REST 1sec for the partial current minute). **Sufficient for a delayed
chart:** the canonical state is the provider's minute bars, which REST serves exactly and without
observed revisions, so there is no trade-level deduplication problem. A permanent hub must also treat
`max_connections`/1008 as "another client took the feed" (bounded backoff and an alert, never a
reconnect loop that fights the other connection).

### Connection limit: design consequences (owner-recorded 2026-09-30)

OBSERVED: all five futures fit on one WebSocket connection; a second connection with the same
account/key **displaced the existing one**, and the older connection received `max_connections` /
close **1008**. Therefore the permanent design must use **one centralized Massive provider/feed hub**
(the provider/feed-scoped Durable Object topology); **browser tabs never connect to Massive**; and
**development processes must not compete with a deployed Massive hub** (mechanism to be designed).
On `max_connections` / 1008: **back off and surface the conflict**; never start a reconnect fight.

### Licensing (the only blocker for CLOUD deployment)

Massive market data terms (VERIFIED verbatim 2026-09-30; no delayed-data exception): licence
"exclusively for your personal, non-business, and non-commercial purposes"; "you may not use the
Market Data to build an application intended for use by end users other than you"; Market Data may
not be "transmitted, or distributed in any way (including 'mirroring') to any other computer,
server, website, or other medium for publication or distribution or for any business or commercial
enterprise, without Massive's express prior written consent"; "any and all Market Data is strictly
for display use only"; prohibited "(d) Use Market Data for non-display use"; CME recipients certify
Non-Professional status, "a maximum of two Order Routing Devices", personal/private use managing own
assets. Local testing on the owner's machine is ordinary personal display use; a Cloudflare Durable
Object that receives and normalizes the data is the open question. **Do not deploy Massive data to
Cloudflare until Massive confirms in writing.** Confirmation needed: an individual Futures Starter
subscriber may use Massive → a private Cloudflare Durable Object → a private Fume client → the same
individual subscriber only, with no customers, no third parties, no redistribution, no resale, no
commercial service and no public API.
