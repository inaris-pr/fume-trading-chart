# Market data: canonical candles, historical/live reconciliation

## Owner decisions this design implements

- **Q4:** charts show **regular trading hours by default**. Extended hours are supported by the architecture (`SessionMode = 'regular' | 'extended'`) but aren't enabled in the MVP.
- **Q5:** intraday candles are **session-aligned** and **built by Fume** from lower-timeframe data. Fume never depends on a provider's native 1h (or daily) candles.

## Canonical candles (provider-neutral)

A **canonical candle** is defined only by the instrument's session windows, the session mode and the timeframe. The provider doesn't enter into it.

**1. Select windows.** For each trading day, `MarketSession.windows` are filtered by session mode:

- `regular`: windows with `kind = 'regular'`;
- `extended`: all windows.

Equities RTH is one window, 09:30–16:00 ET, with early closes applied by the calendar. Futures supply their own windows, which may cross midnight and have breaks.

**2. Intraday buckets** (`1m`, `5m`, `15m`, `1h`, `4h`, duration `D`). For the selected window `W` containing `t`:

```
start = W.start + floor((t − W.start) / D) · D
end   = min(start + D, W.end)
```

Buckets are anchored at the window start and **clipped at the window end**, so the last bucket may be shorter. A bucket never spans two windows, a break or a session boundary.

The arithmetic is on absolute UTC milliseconds, within a window that was already resolved to UTC for that specific day. So DST changes the window's UTC position, never the bucket arithmetic.

**3. Daily bucket** (`1d`): one per `sessionDate`, covering all selected windows of that session. `start` = the first selected window's start. The session date is not the UTC or local calendar date (futures sessions begin the previous evening).

**US equities, regular mode, 1h:**

| Normal day          | Early close (13:00) |
| ------------------- | ------------------- |
| 09:30–10:30         | 09:30–10:30         |
| 10:30–11:30         | 10:30–11:30         |
| 11:30–12:30         | 11:30–12:30         |
| 12:30–13:30         | 12:30–13:00 (short) |
| 13:30–14:30         |                     |
| 14:30–15:30         |                     |
| 15:30–16:00 (short) |                     |

For `5m` and `15m`, anchoring at 09:30 gives the same boundaries as clock alignment, because 09:30 is a multiple of both.

**US equities, regular mode, 4h** (added in Stage 2): 09:30–13:30, then a short 13:30–16:00. A futures instrument gets its own 4h buckets from its own session windows by the same rule.

Candle fields: `open` = first, `close` = last, `high`/`low` = max/min, `volume` = Σ. `tradeCount` = Σ only if every input has it. `vwap` = Σ(vwap·volume)/Σvolume only if every input has it, otherwise omitted. There are **no synthetic bars**: a bucket with no input has no candle, and it shows as an empty slot on the time axis.

## Historical canonical candles (built server-side by `@fume/core`)

`GET /api/v1/bars` always returns **canonical** candles. The Worker builds them from provider **base bars**:

1. A provider adapter declares the native bar intervals it serves (`nativeIntervalsMinutes`, e.g. `[1, 5, 15]`), each **epoch-aligned**: boundaries at multiples of the interval since the Unix epoch, UTC. It declares only intervals whose alignment and start-labeling are verified (spike S1).
2. For the requested timeframe and session windows, the backend chooses the **coarsest native interval `B` that nests exactly**: every canonical bucket boundary must be a multiple of `B`. If none nests, it uses `1m`.
3. Base bars outside the selected windows are dropped (e.g. extended-hours bars in regular mode). Base bars are then folded into canonical buckets with the rules above.
4. **A base bar that would straddle a canonical boundary is a configuration error.** It's rejected loudly, never silently split or assigned.

**Choice for Alpaca IEX, regular mode** (native `[1, 5, 15]` verified by S1 on 2026-09-29, see [research.md](research.md#spike-s1-results-2026-09-29)):

| Timeframe | Base    | Why                                                                                                                                                                                                                     |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1m        | `1Min`  |                                                                                                                                                                                                                         |
| 5m        | `5Min`  | 09:30 and 16:00 are 5-minute boundaries                                                                                                                                                                                 |
| 15m       | `15Min` | same, for 15 minutes                                                                                                                                                                                                    |
| 1h        | `15Min` | session-aligned hours (09:30, 10:30, …, 15:30, 16:00) are all 15-minute boundaries; Alpaca's native `1Hour` isn't used                                                                                                  |
| 1d        | `15Min` | the RTH daily candle = fold of the session's regular-window 15m bars. Alpaca's `1Day` isn't used, because its session definition (extended-hours inclusion) is unverified and would break the "regular by default" rule |

Cost check against the Basic 200 requests/min limit, **as observed** (2026-09-29): despite `limit=10000`, Alpaca returned IEX `15Min` pages of about 730–740 bars (roughly one month, including pre/post-market bars) and one month of `1Min` in a single 7,925-bar page. Upstream calls therefore scale with the **time span**, not the bar count: 500 hourly candles (72 sessions) took 3 bar pages; 150 daily candles (150 sessions) 6–7 pages. The browser requests 1m 1000 / 5m 800 / 15m 600 / 1h 500 / 4h 150 / 1d 150 candles per page to stay at 1–7 upstream calls per request; the Worker caps one base-bar fetch at 10 pages.

Had S1 failed, the adapter would declare `[1]` only (candles identical, higher cost). It passed, so `[1, 5, 15]` is declared (`ALPACA_NATIVE_INTERVALS`).

**Extended-hours base bars.** IEX `15Min`/`1Min` history includes pre/post-market bars inside the requested time range (observed: 15Min bars from 08:00 to 16:15 ET). They are dropped by the regular-mode canonical fold and counted (`droppedOutsideSession`). The base-bar limit is therefore sized on the wall-clock span, not on regular minutes, and a truncated fetch never produces a partial candle (the oldest incomplete buckets are omitted).

**Consistency check (S1):** for one full day, canonical candles built from `15Min` base bars must equal those built from `1Min` base bars (OHLC exact, volume exact). This proves the base-interval choice doesn't change results.

## Live data

| Need                                       | Normalized event    | Alpaca source                        | Status                               |
| ------------------------------------------ | ------------------- | ------------------------------------ | ------------------------------------ |
| **Every trade, driving the active candle** | `trade`             | `trades` channel                     | VERIFIED                             |
| Official completed minute (reconciliation) | `bar` final, `1m`   | `bars`, right after each minute      | VERIFIED                             |
| Correction of a completed minute           | `bar` revised, `1m` | `updatedBars`, after the half-minute | VERIFIED                             |
| Halts                                      | `instrument_status` | `statuses`                           | VERIFIED channel; mapping UNVERIFIED |

Alpaca `dailyBars` isn't subscribed in the MVP: Fume builds the daily candle itself (see above). The `bar` event's `interval: 'session'` and `phase: 'provisional'` stay in the contract for providers whose running bars match Fume's session rules.

**Two mechanisms, two jobs:**

1. **Live display (trades).** Every normalized `trade` updates the active candle of the displayed timeframe immediately.
2. **Reconciliation (official minute bars).** Provider final and revised 1m bars replace the minute Fume built from trades (the provider may exclude some trade conditions; spike S4 measures this). Canonical candles are then re-folded from the corrected minutes. This happens silently and never delays live updates.

**Session mode on the live path:** the hub forwards every trade. In regular mode, the client aggregator ignores trades and minute bars whose time isn't inside a selected window, so pre/post-market prints don't appear. The current-price line follows the same rule. Its label shows the last regular-session price with an "after hours" marker outside RTH. (A last-trade-including-extended-hours display is a later option.)

## Implementation status (Stage 3)

Implemented and tested with the deterministic replay provider (`@fume/replay`); the same code path will be fed by Alpaca in Stage 5:

- `parseRfc3339ToEpochNs`, `epochNsToMs`, `compareEpochNs`, `compareTradeOrder` in `packages/core/src/event-time.ts` (BigInt, no float for nanoseconds).
- `LiveCandleAggregator` (`packages/core/src/live/live-aggregator.ts`): the minute state and precedence rules below, bounded dedupe, bounded retention, diagnostics.
- `applyBufferedHandoff` and `mergeCanonicalBars` (`packages/core/src/live/handoff.ts`): the handoff steps 4-5 below.

**Retention policy.** Minute state is kept for 2 × 1440 minute slots behind the newest event (two full days of 24-hour sessions; about 7 RTH sessions). Older minutes are pruned in batches, and the covered range moves forward with them. A correction (final/revised bar) or trade for a minute that is older than the retained/seeded coverage is **dropped and counted** (`eventsOutsideRetention`); a canonical bucket that starts before the coverage is **not re-folded** (`uncoveredBuckets`), because its earlier minutes are unknown. Nothing is guessed. The host seeds the aggregator with official minutes from at least the start of the previous session, which covers every bucket up to 1D.

**Trade identity.** Trades are de-duplicated by `venue + tradeId` in a bounded set of the 10,000 most recent identities. Trades without an id cannot be de-duplicated; a redelivered id-less trade is counted twice (documented limitation).

## Implementation status (Stage 4, historical)

- `packages/core/src/history.ts`: `nestsExactly`, `selectBaseInterval`, `canonicalBucketEnd`, `canonicalSlotsBefore`, `buildCanonicalBars` (shared TimeScaleMapping + `aggregateBars`, plus the ended-and-final status rule).
- `apps/worker/src/canonical-history.ts`: page planning (sessions → base interval → one ranged fetch → canonical → newest `limit`).
- `apps/worker/src/providers/alpaca/`: base bars from the single-symbol endpoint with explicit `feed=iex`, `adjustment=raw`, `sort=desc`, an explicit `start` (never the upstream default), and one helper for Fume's exclusive `end` (Alpaca's `end` is inclusive: `end − 1 ms`, and results are also filtered to `start < end`).
- Verified on real data (2026-09-29): Worker candles for the completed session equal the fold of the raw recorded `1Min` fixture for all six timeframes (OHLC, volume, trade count; 0 mismatches). 1h starts 09:30…15:30 (short last), 4h 09:30/13:30, 1d one candle. The 2025-11-28 early close gives 1h 09:30…12:30 (12:30–13:00 short) and one 4h candle 09:30–13:00.
- **Observed IEX history gap:** Alpaca IEX returned **no bars at all** for 2025-03-10 (SPY and TSLA; the SIP feed has data, and the calendar lists a normal session). Fume shows an empty session; nothing is fabricated.
- **Not observed yet:** an in-progress bucket with real data (all QA ran after the close). The status rule is covered by tests.

## Timestamps and ordering

- Every event carries `EventTime { ns, ms }` (see [domain-model.md](domain-model.md#timestamps)).
- The deterministic ordering key for trades is `(time.ns, ingestSeq)`.
- Bucket assignment uses `time.ms`. That's exact, because every canonical boundary is a whole second.

## Precedence and keys

1. Bars are keyed by `(instrumentId, sessionMode, timeframe, start)`, and every write is an upsert, so duplicates are harmless.
2. For a 1m key: `revised` (higher `revision`) > `final` > provisional-from-provider > provisional-from-trades. Provisional never overwrites final.
3. A canonical candle is `final` only when its bucket end has passed **and** every contained minute (or base bar) with data is final.

## Historical → live handoff

When the chart opens (or after a timeframe, symbol or session-mode switch, or a resync):

1. Open or confirm the WS subscription, and **buffer** incoming `market` events.
2. `GET /bars?timeframe=<tf>&session=regular` (latest page of canonical candles).
3. For timeframes above 1m, also fetch the **1m bars of the current canonical bucket**: up to 60 for 1h, and the session's regular minutes so far (≤ 390) for 1d. This seeds the live aggregator.
4. Merge buffered `bar` events (upsert rules), then buffered `trade` events whose minute isn't already final.
5. Drain the buffer and go live.

On `resync(market)`, steps 2–5 re-run for just the tail. Loaded older history is kept.

## Live aggregation (in `@fume/core`, pure and deterministic)

**State:** `minutes`, a map of 1m `start` → `{ official?: Bar; fromTrades?: Bar }` for the current canonical bucket, plus a small retained window of recent buckets for late corrections.

**Applying a trade** (O(1)):

1. Drop the trade if it's outside the selected session windows.
2. De-duplicate on `(venue, tradeId)` (bounded LRU, about 10k entries). Trades without an id aren't de-duplicated (documented limitation).
3. If its minute already has an `official` bar, ignore it. The provider sends `revised` if it mattered.
4. Otherwise update `minutes[m].fromTrades`. `open`/`close` come from the earliest/latest trade by `(time.ns, ingestSeq)`; `high`/`low` are max/min; `volume` and `tradeCount` accumulate. **Out-of-order trades give identical results.**
5. Re-fold the active canonical candle (per minute: `official ?? fromTrades`) and schedule one chart update per animation frame.

**Rollover:** the first event in a later canonical bucket opens a new active candle. The previous one stays addressable by key for late corrections (`chart.upsertBars`). Nothing is created for empty buckets in between. For 1h, the rollover at 15:30 opens the short 15:30–16:00 candle, and 16:00 ends it.

**Late and early events:**

- A trade for a non-final minute updates that minute.
- A trade ahead of the current bucket starts that bucket.
- A trade older than the retained window is dropped and counted in diagnostics.

## Required tests (Stage 3)

- Canonical bucket function:
  - every 1h RTH bucket, including the short 15:30–16:00;
  - an early-close day (12:30–13:00 short);
  - a DST spring-forward and fall-back day in `America/New_York`;
  - a futures-style session crossing midnight with a scheduled break;
  - extended mode (per-window anchoring).
- Base-interval selection: 15m nests into 1h RTH; a non-nesting base is rejected; a straddling base bar raises an error.
- Canonical history from 15m base = from 1m base (property test over a synthetic day).
- Regular mode drops extended-hours trades and base bars.
- Out-of-order trades give identical OHLCV; exact-`ns` ties are broken by `ingestSeq`; ns comparison works beyond 2^53.
- Duplicate trades.
- The active 5m/15m/1h/1d candle changes on **every** trade.
- Final replaces trade-built; revised replaces final; a late trade after final is ignored.
- Rollover for every timeframe; an empty minute (no bar, visible gap).
- Historical/live merge with overlapping buffered data.
- Replay determinism (same tape → byte-identical output).
