# Chart performance baseline (Stage 1)

Measured 2026-09-29 with the benchmark page (`/?bench`, a lazily loaded chunk that exposes no globals) against the **production build**
(`vite build` + `vite preview`). The page times the synchronous CPU cost of `FumeChart.render()`,
which covers the frame model plus the Canvas 2D commands. GPU rasterization and compositing are
not included.

**Environment:** Windows 11 Home; Chromium 152 (the Claude desktop app's built-in browser, running as
a background tab); `devicePixelRatio` 2; 12 logical cores; stage 657×800 CSS px (1314×1600 device
px); `performance.now()` resolution about 0.1 ms. The browser tab was hidden, so frames were
scheduled with `setTimeout` instead of `requestAnimationFrame` (bench-only environment). The render
path itself is the production one.

Two production runs (the ranges show run-to-run variance):

| Bars   | View                                      | Candles drawn | Index bars (ms) | First render (ms) | Redraw median (ms) | Redraw p95 (ms) |
| ------ | ----------------------------------------- | ------------- | --------------- | ----------------- | ------------------ | --------------- |
| 500    | default (7 px/slot, latest)               | 80            | 1.8–6.2         | 6.7               | 0.4–0.5            | 4.3–4.7         |
| 1,000  | default                                   | 80            | 0.5–1.2         | 0.5–0.8           | 0.2–0.3            | 1.0–1.2         |
| 10,000 | default                                   | 80            | 5.6–9.0         | 0.8–6.5           | 0.3                | 0.7–1.6         |
| 500    | every bar visible (stress)                | 499           | n/a             | 1.2–2.4           | 0.5–0.6            | 4.9–7.2         |
| 1,000  | every bar visible (stress)                | 999           | n/a             | 2.1–9.7           | 0.8–1.3            | 6.5–13.9        |
| 10,000 | every bar visible, ~0.07 px/slot (stress) | 9,999         | n/a             | 23.4–23.8         | 24.0–30.1          | 53.1–58.0       |

(The dataset has one deliberately dropped bar, so N requested bars render as N−1.)

## Assessment

- **Normal views are cheap and independent of dataset size.** Only visible bars are drawn, and the
  visible range is found by binary search. With 10,000 loaded bars, a default redraw costs about the
  same as with 500. This meets the Stage 1 target (10k bars: first render < 100 ms, redraw < 8 ms)
  for the default view.
- **Indexing** (mapping every bar to its slot once per `setBars`) costs about 6–9 ms for 10,000 bars.
  It runs once per data change, not per frame.
- **Stress case:** squeezing 10,000 candles into ~660 px costs about 24–30 ms per redraw, because
  every candle is drawn although about 15 share each device-pixel column. That's not a Stage 1 view,
  but Stage 2 zoom-out can reach it. The known remedy is **per-pixel-column aggregation** (draw one
  min/max bar per column when `barSpacing` < 1 device px). It's local to `frame.ts`, doesn't change
  the architecture, and should be measured again in Stage 2 before it's built.
- There's no reason to consider WebGL.

## Stage 2 interaction baseline

Measured 2026-09-29 with `/?bench` against the production build. Environment: Chromium 152 (built-in
browser, hidden tab), `devicePixelRatio` 1, 12 logical cores, stage 977×800 CSS px. Data: SPY
deterministic 1-minute bars (the last N bars, and the full 66,277-bar series). Two runs are shown as
ranges; times are medians of 60 synchronous calls.

| Bars   | `setData` (index + axis measure) | Full repaint (frame + candles) | Overlay-only repaint (crosshair move) | Max zoom-out: candles drawn / full repaint |
| ------ | -------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------ |
| 1,000  | 5.5–5.7 ms                       | 0.6–0.7 ms                     | 0.2 ms                                | 534 / 1.1–1.3 ms                           |
| 10,000 | 8.8–12.2 ms                      | 0.4–0.5 ms                     | 0.1 ms                                | 534 / 0.8–1.2 ms                           |
| 66,277 | 77–90 ms                         | 0.5 ms                         | 0.1 ms                                | 534 / 0.8–1.0 ms                           |

- **Pointer moves never rebuild candles.** The crosshair lives on the overlay canvas, so a move
  costs about 0.1–0.2 ms, regardless of dataset size.
- **Pan and zoom** repaint the main layer at about 0.5–1.3 ms, because only visible bars are
  processed. The minimum bar spacing (1 CSS px) and bounded right overscroll keep the worst case
  small. The Stage 1 stress case (10k candles squeezed into ~660 px, ~24–30 ms) is no longer
  reachable through interaction.
- **Switching to 1m (66k bars) costs ~80–90 ms once**, dominated by mapping every bar to its slot in
  `setData`. It happens once per switch, not per frame. If it becomes noticeable with real data, the
  first optimization is indexing lazily or in chunks; no architectural change is needed.

## Stage 3 live-path baseline

Measured 2026-09-29 with `/?bench` against the production build (Chromium 152, hidden tab, DPR 1,
12 cores, stage 977×800 CSS px). Two runs, shown as ranges. `performance.now()` resolution is about
0.1 ms, so values below that read as 0.0.

| Displayed timeframe | Loaded history | Aggregator: apply one trade + re-fold bucket | + `chart.upsertBars` + repaint |
| ------------------- | -------------- | -------------------------------------------- | ------------------------------ |
| 1m                  | 66,159 bars    | < 0.1 ms                                     | 0.3–0.6 ms                     |
| 5m                  | 13,232 bars    | < 0.1 ms                                     | 0.5–0.6 ms                     |
| 1h                  | 1,188 bars     | ~0.1 ms                                      | 0.5 ms                         |
| 4h                  | 340 bars       | 0.0–0.1 ms                                   | 0.6 ms                         |
| 1d                  | 170 bars       | 0.3–0.5 ms (re-folds up to 390 minutes)      | 0.4–0.6 ms                     |

- A live trade never re-indexes the series: replacing the active candle is a binary search plus
  one assignment, and appending allocates once per new candle. The per-trade cost is independent of
  the loaded history (66k 1m bars cost the same as 170 daily bars).
- The 1D re-fold scans the current session's minutes (≤ 390 in RTH). That is the largest bucket and
  still well under a millisecond. No incremental fold was needed.
- Crosshair (overlay-only) repaint stays at 0.1–0.4 ms while live updates run.
- `setData` for all 66k 1m bars: 36–90 ms once per symbol/timeframe switch (unchanged from Stage 2).

## Stage 4 historical-data baseline (Alpaca IEX, local Worker)

Measured 2026-09-29 (after the close) with `wrangler dev` on this machine, real Alpaca Basic/IEX data, the Worker's per-request log (`ms` = Worker time including upstream calls) and the browser's resource timings. Latency is dominated by Alpaca's responses and varies run to run; ranges are the observed spread.

| Request (browser page size)   | Base interval | Upstream calls | Base bars fetched | Canonical bars | Worker time           |
| ----------------------------- | ------------- | -------------- | ----------------- | -------------- | --------------------- |
| SPY 1m (1000)                 | 1Min          | 1–3            | 1,177–1,178       | 1000           | 0.27–1.6 s            |
| SPY 5m (800)                  | 5Min          | 1              | 905               | 800            | 0.23–0.44 s           |
| SPY 15m (600)                 | 15Min         | 1              | 677–702           | 600            | 0.28–0.72 s           |
| SPY 1h (500)                  | 15Min         | 3              | 2,078–2,380       | 500            | 0.47–3.4 s            |
| SPY 4h (150)                  | 15Min         | 3–4            | 2,167–2,462       | 150            | 0.55–1.3 s            |
| SPY 1d (150)                  | 15Min         | 6–7            | 4,054–4,986       | 149–150        | 1.2–2.3 s             |
| Older page, 1d (150)          | 15Min         | 6              | 4,054–4,436       | 149–150        | 1.26–1.54 s (browser) |
| `/sessions` (cached years)    | —             | 0              | —                 | —              | 11–20 ms (browser)    |
| `/instruments/resolve` (cold) | —             | 1              | —                 | —              | ~0.56 s               |

- **Canonical aggregation** (`buildCanonicalBars`, Node 24, same base-bar counts incl. dropped pre/post-market bars): 1m 0.43 ms, 5m 0.22 ms, 15m 0.19 ms, 1h 0.57 ms, 4h 0.46 ms, 1d (4,500 base bars, 150 sessions) 1.04 ms median. Aggregation is negligible next to upstream latency.
- **Upstream paging observed:** IEX `15Min` pages of ~730–740 bars (about one month) regardless of `limit=10000`, so upstream calls scale with the time span. Requesting 300 daily candles hit the 10-page cap and returned 248 complete candles (`hasMore: true`); the browser therefore requests 150 per page for 4H/1D.
- **Rate budget:** the largest request (1D) costs ≤ 7–9 upstream calls (bars + calendar/asset when not cached), well under the Basic 200 requests/min for one user; the chart keeps one older-page request in flight.
