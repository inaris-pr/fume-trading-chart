# Chart performance baseline (Stage 1)

Measured 2026-09-29 with the dev-only benchmark page (`/?bench`) against the **production build**
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
