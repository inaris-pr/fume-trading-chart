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
