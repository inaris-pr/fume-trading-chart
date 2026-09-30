# Roadmap, acceptance criteria, tests, risks

## Stage 4 status (2026-09-29, awaiting review)

Implemented locally (no deployment): `apps/worker` with `/health`, `/instruments/resolve`, `/sessions`, `/bars`; the Alpaca historical adapter (IEX, raw); canonical history in `@fume/core`; the browser's `?source=api` historical mode with older-page loading. S1 ran on real data and **passed** (native `[1, 5, 15]`; details in [research.md](research.md#spike-s1-results-2026-09-29)). All **six** timeframes (1D, 4H, 1H, 15m, 5m, 1m) load in the browser, not five as first written below. Deviations: the browser mode is named `?source=api` (the web app never names a provider); Worker tests run in Node with injected `fetch` instead of `@cloudflare/vitest-pool-workers`.

## Roadmap correction (Stage 3, 2026-09-29)

Stage 2 delivered canonical historical aggregation (1m → 5m/15m/1h/4h/1d, session-aligned) earlier than planned. Stage 3 completed the rest of the planned Stage 3 foundation **before** any real provider:

- exact `EventTime` helpers; trade-by-trade live aggregation with official/revised minute reconciliation;
- the deterministic `ReplayMarketDataProvider` (`@fume/replay`) with an injectable scheduler;
- incremental chart updates (`upsertBars`) that keep the user's view, older-history `prependBars` without a jump, and the `onNeedsOlderData` signal that Stage 4 pagination will use.

Stage 4 is unchanged: Worker + Alpaca historical adapter + real historical bars. Later stages are not renumbered.

## Changes from the original stage plan

| Change                                                                                                                                                                                                                                                   | Reason                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New Stage 3: aggregation engine + replay provider**, before any Alpaca code                                                                                                                                                                            | Candle correctness is the highest-accuracy requirement. It's pure logic, testable without a market, and live Alpaca data only makes sense if the aggregator is already proven. |
| **Spikes S1–S2 run early**, as soon as you've put paper keys in `.dev.vars`. They can overlap Stages 1–3                                                                                                                                                 | Alpaca bar alignment, IEX sparsity and the connection limit shape Stages 3–5. Better to learn them before building on assumptions.                                             |
| **Preview deploy behind Cloudflare Access in Stage 5** (the old Stage 8 is split)                                                                                                                                                                        | Durable Object outbound WebSockets, binary frames and Access-with-WebSockets are Cloudflare-specific risks. Finding them in the last stages would be expensive.                |
| Contracts versioned `/api/v1` from day 1                                                                                                                                                                                                                 | This makes the reusability stage packaging and docs instead of redesign.                                                                                                       |
| Old Stages 8–11 renumbered 9–12                                                                                                                                                                                                                          |                                                                                                                                                                                |
| **Stage 0 revision (owner corrections):** trade-level live contract; `EventTime` ns timestamps; session-aware time axis; streamed-immediate trading state; conditional DO with a cost gate; origin allowlist separate from auth; React shell decided now | See ARCHITECTURE §2.1, §4.1, §5, §6 and the docs linked there.                                                                                                                 |

## Stages and acceptance criteria

Every stage also requires: `pnpm typecheck`, `pnpm test` and `pnpm format:check` green; no secrets in git; docs updated; your explicit approval before the next stage.

**Stage 0: Architecture (this stage).** Docs, core contracts type-check, repo foundation. ✅ criteria: this report is accepted.

**Stage 1: Static Canvas chart (generated data).** `@fume/chart` (framework-free) + the `apps/web` React shell (`<ChartHost>`) render a deterministic generated series.

- Candles (body/wick, up/down colors, 1px-crisp at DPR 1, 2 and 3), grid, price scale, time scale, current-price line and label.
- Pure coordinate functions (`slot↔x`, `price↔y`) with unit tests, including round-trip error < 0.5 px.
- The chart consumes the `TimeScaleMapping` interface (ARCHITECTURE §4.1). With a fixed weekly **RTH** schedule mapping (regular mode, 09:30–16:00 ET), nights and weekends are compressed, a deliberately removed in-session bar shows as an **empty slot**, and session separators are drawn. Time labels are correct in `America/New_York` and in a second zone.
- `@fume/chart` has no React import (checked by a dependency test). Unmounting `<ChartHost>` calls `destroy()` and leaves no listeners or observers behind.
- Negative and sub-penny prices render with the injected formatter.
- 10,000 bars: first render < 100 ms and redraw < 8 ms on your machine (measured and recorded, not asserted in CI).

**Stage 2: Interaction.** Pan (drag), zoom (wheel and trackpad pinch, anchored at the cursor), crosshair with the OHLC legend, auto/manual price scaling, resize, `needsOlderData` triggering a delayed mock loader that prepends without the view jumping.

- Tests: zoom keeps the bar under the cursor fixed; pan clamps at both ends; prepending N bars keeps the visible time range unchanged; visible-range computation.
- Manual check: 60 fps feel when panning 10k bars (DevTools trace attached to the stage report).

**Stage 3: Aggregation + replay provider.** `@fume/core` aggregation and a `ReplayMarketDataProvider` that plays a recorded or synthetic trade + bar tape at N× speed into the chart.

- All tests listed in [market-data.md](market-data.md#required-tests-stage-3) pass.
- Canonical session-aligned buckets: every 1h RTH bucket including the short 15:30–16:00; an early-close day; base-interval nesting (15m → 1h, 15m → 1d); built-from-15m equals built-from-1m; regular mode drops extended-hours trades and bars.
- `EventTime` helpers (`parseRfc3339ToEpochNs`, `compareEpochNs`, `epochNsToMs`) are tested, including ns values beyond 2^53 and tie ordering.
- The session-aware `TimeScaleMapping` is built from `MarketSession[]` (DST, holiday, early close, and a futures-style overnight session with a break).
- The replay tape emits `MarketEvent`s (trades + final/revised minute bars). The active candle visibly updates on **every** trade on the 1m, 5m, 15m, 1h and 1d timeframes.
- Replaying the same tape twice gives byte-identical bar output (determinism test).
- Visual: live candle ticking and rollover across 1m, 5m, 15m, 1h and 1d from the replay; symbol and timeframe switching with the replay.

**Stage 4: Worker + Alpaca history.** `apps/worker`, Alpaca market-data adapter (history only), `/instruments/resolve`, `/bars`, `/sessions`, `/health`.

- Adapter unit tests use **recorded Alpaca fixtures** (captured in S1, with keys removed) to prove normalization (ns timestamp → ms, field mapping, pagination).
- `/bars` returns canonical session-aligned candles (`sessionMode: regular`) built from base bars. `session=extended` is rejected with 400. SPY 1h candles show 09:30, 10:30, …, 15:30 (short) starts, verified against the S1 fixtures.
- SPY loads in the browser on all five timeframes, and scrolling left pages history until 2016 or a set limit.
- The browser network tab and built bundle contain no Alpaca host or credential (automated grep on `dist/`).
- The feed label shows "IEX".

**Stage 5: Real-time + preview deploy.** Alpaca stream adapter, stream hub, `/api/v1/stream`, live candles; preview deployment behind Access.

- **First, the S3 gate** (ARCHITECTURE §6): a full-session DO run with a recorded duration-usage/cost extrapolation and your go/no-go. The implementation that follows is either the StreamHub DO or the single-tab fallback.
- The active candle updates on every IEX trade on all timeframes. Official minute bars reconcile within about 2 s of the minute mark.
- DO path: two browser tabs share one upstream connection (hub logs show one Alpaca socket; no 406). Fallback path: a second tab shows "open elsewhere", and a refresh reconnects without a lasting 406.
- Killing the upstream socket (dev endpoint) → `resync` → the chart tail is corrected and no duplicate bars appear.
- The upstream closes about 60 s after the last client disconnects (DO path).
- Preview URL is unreachable without Access login, including the WS upgrade.

**Stage 6: Paper trading.** Alpaca trading adapter, snapshot/orders/cancel/close routes, trade_updates via hub, order panel (buy/sell, market/limit, qty, limit price, buying power, position, open orders + cancel, close position).

- Order validation unit tests (every rule in [security.md](security.md#trading-request-validation)), including `extendedHours: true` → `400 invalid_request`. The order panel has no extended-hours control.
- Provenance tests: after a streamed fill, position qty is `stream`, avg entry and P&L are `derived`, all `provisional: true`. After `positionSnapshot`, all are `snapshot`/`provisional: false`.
- Reducer tests: out-of-order events, duplicates, a partial→partial→fill sequence, cancel vs. fill race, terminal immutability, the avg-entry estimate (add, reduce, flip, flat), a stale-snapshot guard, and snapshot overriding stream.
- A streamed fill updates the order, position qty and estimated avg entry in the UI **before** the REST snapshot arrives (asserted with a delayed fake snapshot). Buying power shows "syncing" until `accountSnapshot`.
- Live paper checks: market buy fills; limit order rests and shows working; cancel removes it; short sell (if allowed) and close; a market order outside RTH shows as queued/accepted, not filled.
- Live-trading guard: pointing `ALPACA_TRADING_BASE_URL` at the live host makes trading routes return 503 (tested).

**Stage 7: Trading on the chart.** Avg-entry line with qty and live P&L; limit-order lines showing the remaining qty; per-execution buy/sell markers; cancel/close update the chart after broker confirmation.

- P&L tests for long, short and a futures-style multiplier.
- Partial fills produce separate markers and a line with the correct remaining qty.
- After a refresh, markers for today's fills are restored from broker history (depends on S6).

**Stage 8: Recovery and hardening.** Client/hub backoff, stale detection, seq-gap resync, ambiguous-submit handling, the 60 s backstop snapshot.

- Fault-injection tests (fake WebSocket) for every row of the table in [trading-state.md](trading-state.md#scenarios).
- A manual run of "disable network 30 s during an open order that fills" ends with the correct state.

**Stage 9: Production deploy.** Custom domain, Access policy, JWT verification, `workers.dev` off, observability, deploy runbook.

- Unauthenticated requests are rejected (curl test). Secrets are set only via `wrangler secret`. The runbook reproduces the deploy from a clean checkout.

**Stage 10: Package and contract stabilization.** `@fume/chart` build output + README, `@fume/chart-react` extracted from `<ChartHost>` if the consumer is React, `FumeClient`, frozen v1 contract docs, the external platform's origin added to `FUME_ALLOWED_ORIGINS`, and its authenticator (service token or signed short-lived token) implemented.

- A minimal example page consumes `@fume/chart` + `FumeClient` using only the documented contract.

**Stage 11: Standalone E2E validation.** Playwright smoke test (load, switch symbol and timeframe, place and cancel a paper limit order), a full-session soak (market open to close), and an IEX-vs-other-platform comparison documented as feed differences.

**Stage 12: External integration.** Only after approval.

## Minimum automated test strategy

| Layer         | What                                                                                                                                                                   | Tool                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `@fume/core`  | Aggregation, bucket/DST math, order reducer, validators, P&L                                                                                                           | Vitest, pure and deterministic, fixed clock |
| `@fume/chart` | Coordinate transforms, viewport math (zoom/pan/visible range), layout. Rendering via a recording fake `CanvasRenderingContext2D` for a few golden draw-call assertions | Vitest                                      |
| Adapters      | Payload → domain normalization from recorded fixtures; error mapping                                                                                                   | Vitest                                      |
| Worker/DO     | Routes, validation, hub fan-out/ref-counting, resync on upstream drop, with a fake upstream socket                                                                     | Vitest + `@cloudflare/vitest-pool-workers`  |
| E2E           | One smoke flow against paper                                                                                                                                           | Playwright (Stage 11 only)                  |

No test may depend on a live market or the wall clock.

## Risks and spikes

Each spike is the smallest experiment that retires the risk. S1, S2 and S5 need your paper keys in `apps/worker/.dev.vars` (never in chat).

| #   | Risk / assumption                                                                                                                                                                                                                       | Spike                                                                                                                                                                                                                                                                              | When                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S1  | Alpaca bar `t` = bar start; `1Min`/`5Min`/`15Min` bars are epoch-aligned; the in-progress bar is/isn't returned; IEX sparsity for SPY in RTH                                                                                            | A Node script fetches SPY `feed=iex` for one full day at 1Min/5Min/15Min, saves redacted JSON fixtures, prints alignment and gap stats, and checks that canonical 1h/1d candles built from 15Min equal those built from 1Min                                                       | **Done 2026-09-29: passed** (see research.md) |
| S2  | Connection limit of 1: per key or per account? What happens to the old socket on a second connect?                                                                                                                                      | A script opens two IEX stream connections with the same key and logs the 406 behavior                                                                                                                                                                                              | Before Stage 5                                |
| S3  | A DO holds outbound WSs to Alpaca (text + **binary** frames), auths within 10 s, and survives a full session; eviction behavior; `Intl` time zones work in workerd; **duration usage/cost while sockets are open (idle tabs included)** | A minimal DO in `wrangler dev`, then a preview deploy relaying IEX + trade_updates to one browser for a **full regular session**. Record disconnects, evictions and dashboard duration usage, extrapolate to 6.5 h and 16 h/day, and present a go/no-go vs the single-tab fallback | Start of Stage 5                              |
| S4  | Provisional minute from IEX trades vs the official minute bar: how different?                                                                                                                                                           | Log both for 30 min during RTH and diff OHLCV per minute                                                                                                                                                                                                                           | Stage 5                                       |
| S5  | Real order/account/position response shapes; duplicate `client_order_id` behavior; `orders:by_client_order_id` exists; trading API rate limit                                                                                           | A script against paper: submit and cancel a far-from-market limit order, capture redacted fixtures                                                                                                                                                                                 | Before Stage 6                                |
| S6  | Per-execution fill history after refresh (account activities FILL, or equivalent)                                                                                                                                                       | A script queries activities after S5 fills                                                                                                                                                                                                                                         | Before Stage 7                                |
| S7  | Cloudflare Access protects a Worker custom domain **including WS upgrades**; JWT verification in the Worker                                                                                                                             | A preview deploy with a hello WS                                                                                                                                                                                                                                                   | Stage 5                                       |
| R8  | Canvas 2D is fast enough at 10k bars                                                                                                                                                                                                    | Stage 1 benchmark (acceptance criterion)                                                                                                                                                                                                                                           | Stage 1                                       |
| R9  | Trade volume on the per-trade live path overwhelms the browser (unlikely for SPY on IEX)                                                                                                                                                | Measure events/s and frame time during S4. Lossless conflation (websocket-api.md) only if needed                                                                                                                                                                                   | Stage 5                                       |

## Open questions for the owner

Answered:

- **Q1: move the repo out of OneDrive.** Answer: yes, to `C:\Users\inari\Projects\Fume`.
- **Q2: does the Replit platform use this Alpaca market-data WebSocket?** Answer: no. Revisit if that changes (it would compete for the 1-connection limit).
- **Q3: UI framework.** Approved: a React + TypeScript + Vite shell with a framework-independent Canvas engine.
- **Q4: session display.** Regular trading hours by default. Extended-hours display is supported by the architecture but not enabled in the MVP.
- **Q5: 1h alignment.** Session-aligned (09:30–10:30 … 15:30–16:00), built by Fume from lower-timeframe base bars. Provider-neutral.
- **Q6: extended-hours orders.** Always `extendedHours: false` in the MVP. No checkbox.

No open owner questions remain for Stage 1.
