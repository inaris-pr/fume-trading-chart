# Indicators

Status: **Stage 9 "indicator foundation"** (2026-10-01, uncommitted). Built-ins: SMA and EMA (price
overlays), Volume and RSI (separate panes). Not yet: Bollinger Bands, MACD, VWAP, ATR, last-value
axis labels, pane resizing / reordering / merging, indicator undo, persistence (host-owned by
design), any form of user scripts.

## Packages and ownership

```
@fume/indicators (pure)                 @fume/chart                         host (apps/web, React…)
├─ definitions + registry               ├─ ChartIndicators (engine)         ├─ indicator panel UI
├─ instance schema fume.indicators v1   │   instances, IndicatorSeries      ├─ configuration state
├─ calculators (incremental)            │   per instance, invalidation      └─ persistence (later)
└─ IndicatorSeries runtime              ├─ panes, scales, painting, legend
                                        └─ API: set/get/add/update/remove
```

- **`@fume/indicators`** has no dependencies at all (not even `@fume/core`; it reads a structural
  `IndicatorBar { open, high, low, close, volume }`), no DOM, no Canvas, no framework, no network.
  It is reusable outside the browser (e.g. a server-side alert or backtest later).
- **`@fume/chart`** imports it at runtime (the only package that does; enforced by
  `test/boundaries.test.ts`) and owns the runtime state: which instances exist, their computed
  series, pane assignment, scaling, rendering and the legend. React never calculates, lays out or
  manages indicator lifecycles.
- **The host owns persistence** of the configuration (`serializeIndicators` /
  `parseIndicatorDocument`). Computed values are runtime data and are never persisted.

## Definitions (registry)

Engines read `IndicatorDefinition`s; they never switch on indicator types.

| Field              | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `type`, `name`     | Stable id stored in the schema, display name                                                     |
| `placement`        | `overlay` (main price pane, main price scale) or `pane` (own pane below)                         |
| `params`           | Integer parameter specs: key, label, min, max, default (validation lives here)                   |
| `style`            | Style field specs: `color` (CSS color) or `lineWidth` (0.5–5 CSS px), with defaults              |
| `outputs`          | One or more series: `line` or `histogram`, the style keys they use, optional direction colors    |
| `scale`            | `price` (overlays), `auto` (fit visible values, optionally including zero) or `fixed` (min..max) |
| `guides`           | Horizontal reference lines in indicator units (RSI 30 / 70)                                      |
| `valueFormat`      | `price` (instrument format), `volume` (compact K/M/B) or `number` (2 decimals)                   |
| `label(params)`    | Legend label, e.g. `SMA 20`                                                                      |
| `createCalculator` | The incremental calculator for one instance                                                      |

`IndicatorRegistry` validates definitions (unique types; overlays and only overlays use the price
scale; outputs reference existing style keys). Stage 9 ships `BUILTIN_INDICATORS` = SMA, EMA,
Volume, RSI; hosts cannot register definitions (no user scripts). A future indicator (Bollinger
Bands: overlay with three line outputs; MACD: pane with two lines + a histogram; ATR: auto pane;
VWAP: overlay that resets per session) is a new definition, not an engine change.

## Instance model (schema `fume.indicators` v1)

```ts
interface IndicatorInstance {
  id: string; // unique per chart; chart default `ind-` + crypto.randomUUID()
  type: string; // 'sma' | 'ema' | 'volume' | 'rsi'
  params: Record<string, number>; // every param of the definition, validated
  style: Record<string, string | number>; // every style field of the definition
  visible: boolean;
}
```

- Persisted form: `{ format: 'fume.indicators', version: 1, indicators }` with fixed key order
  (params and style in definition order); a test pins the exact JSON.
- `normalizeIndicator` / `parseIndicatorDocument` reject unknown types, unknown keys, non-integer or
  out-of-range params, empty colors, invalid widths, duplicate ids, other formats/versions
  (`IndicatorSchemaError`). Missing params/style fields get the definition defaults. Nothing is
  clamped or guessed.
- Never persisted: computed values, pixel positions, viewport state, bar indexes, pane heights.

## Formulas (exact semantics)

All calculations run over the canonical bars the chart displays: a 5m chart uses Fume's 5m bars, a
1H chart Fume's session-aligned 1H bars. Closed periods have no bars, so they are not samples.
Before an indicator has enough bars there is **no value** (never an invented one); outputs never
contain Infinity (non-finite results become "no value").

| Indicator | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMA(n)    | `(close[i-n+1] + … + close[i]) / n` for `i >= n-1`. Window sum carried forward and re-summed from scratch at the first value and every 512 values (index-based, so incremental and full results are identical; drift ≤ ~1e-12).                                                                                                                                                                                                                   |
| EMA(n)    | `alpha = 2 / (n + 1)`; seed `EMA[n-1] = SMA(n)[n-1]` (plain average of the first n closes); `EMA[i] = EMA[i-1] + alpha * (close[i] - EMA[i-1])`. No value before `n-1`.                                                                                                                                                                                                                                                                           |
| Volume    | `volume[i]` of the displayed bar, unchanged. Histogram from 0, colored by the bar's direction (`close >= open`: up color).                                                                                                                                                                                                                                                                                                                        |
| RSI(n)    | Wilder. `change[i] = close[i] - close[i-1]`, gain/loss = positive/negative part. Seed at `i = n`: averages of the first n gains/losses. Then `avg[i] = (avg[i-1] * (n-1) + x[i]) / n`. RSI from the two averages, at the seed and at every recursive step: gain > 0 and loss = 0 is 100; gain = 0 and loss > 0 is 0; both 0 (completely flat) is 50; otherwise `100 - 100 / (1 + avgGain / avgLoss)`. No value before `i = n` (needs n + 1 bars). |

Defaults: SMA 20, EMA 20, RSI 14 (periods 1–1000, RSI 1–500).

## Calculation pipeline and invalidation

Each instance has an `IndicatorSeries`: outputs and per-bar calculator state indexed by bar
position, plus `validLength` (leading positions that are correct). Calculators recompute
`[from, bars.length)` and may rely on everything before `from`; so a full calculation and any
sequence of suffix updates give **identical** results (tested exactly, not approximately).

| Chart event                                                           | Indicator effect                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `setData` / `setBars` (symbol/timeframe switch)                       | all values discarded; configuration kept; full recalculation             |
| `prependBars` (older history)                                         | full recalculation (positions shift; recursive seeds get better context) |
| `upsertBars`: new bar appended                                        | only the new position is computed                                        |
| `upsertBars`: existing bar replaced (live / provisional / correction) | recompute from that bar to the end (EMA/RSI chains included)             |
| configuration change (params, type)                                   | that instance recalculates; style/visibility changes keep the values     |
| pointer movement, crosshair, zoom, pan                                | nothing is recalculated                                                  |

The merge reports the earliest changed position, so a live tick on a 66k-bar 1m chart recomputes
one position per indicator. Calculation is lazy: it runs once before the next frame (or a value
read) for every **visible** instance; hidden instances keep their stale mark and catch up when
shown. A provisional current candle therefore yields a provisional current indicator value that
follows the candle.

**Loaded history only.** Indicators see the bars the chart has loaded; no hidden history is
fetched for them. When older history is prepended, warm-up moves earlier and recursive values near
the old left edge can change (a better seed context); they converge quickly (EMA/RSI).

## Panes and layout

- `computeLayout` stacks **N panes** above one shared bottom time axis: pane 0 is the main price
  pane (`layout.plot`, unchanged for drawings, coordinates and hit-testing), indicator panes follow
  in configuration order (one pane per visible pane indicator; hidden ones take no pane).
- Heights (`paneHeights`, fixed proportions): each indicator pane gets 20 % of the height within
  40–160 px; together they never exceed half, so the main pane keeps at least 50 % (small charts:
  panes shrink evenly). All panes share x positions (same viewport), so time alignment is exact.
- Each pane has its own vertical scale and axis labels; separators between panes; grid and session
  separators run through every pane.
- Drawings stay attached to the main pane only. Drag and wheel pan/zoom time in any pane (a drag
  in an indicator pane never moves a MANUAL main price window).
- Designed for later: per-pane heights are one function of (total height, count); user resizing,
  reordering or merging would replace that function's input without changing panes, frames or
  painting.

## Scaling

- **Main pane AUTO:** the visible candles **and** the finite values of visible price overlays in the
  visible range (so overlays are never clipped). Hidden overlays do not count. **MANUAL** stays
  exactly the user's range.
- **Volume:** 0 .. visible maximum + 10 % headroom.
- **RSI:** fixed 0..100 (4 px inset), dashed guides at 30 and 70 (also the axis labels).

## Rendering

Indicators are painted in the existing main-frame pass (no extra canvas): main pane = grid,
candles, price-overlay lines, last price; then each indicator pane = separator, grid, guides,
series, axis labels. Lines connect consecutive bars and break where there is no value; histograms
draw one bar per candle from the zero line. Only the visible bars (plus one each side, clipped)
are painted. Drawings keep their own canvas above, the crosshair its overlay canvas. Indicator
painting never causes a React render.

## Crosshair and legend

- The vertical crosshair line spans every pane down to the time axis; the horizontal line and value
  readout belong to the pane under the pointer (its own scale and format).
- Legend (overlay canvas): price overlays below the OHLC row (`SMA 20  612.34`), pane indicators at
  the top of their pane (`RSI 14  55.20`, `Volume  1.25M`). Values are those of the bar under the
  crosshair, or of the latest bar without a crosshair (`—` where there is no value). Values are read
  from the computed series; the legend never recalculates.
- Not in Stage 9: last-value labels on the price axes, in-canvas indicator hit-testing.

## API

`@fume/chart` (`FumeChart`):

```ts
chart.setIndicators(list); // host replacement: not echoed; invalid instances left out
chart.getIndicators(); // current configuration (replaced, never mutated)
chart.addIndicator('rsi', { params: { period: 9 } }); // user command -> id | null
chart.updateIndicator(id, { params?, style?, visible? }); // user command -> boolean
chart.removeIndicator(id); // user command -> boolean
chart.getIndicatorValues(id, time?); // { value: number | null } at a bar time (default latest)
// FumeChartOptions: onIndicatorsChange(indicators, { kind: 'add' | 'update' | 'remove', id }),
//                   createIndicatorId
```

The indicator definitions and schema helpers are re-exported from `@fume/chart`
(`BUILTIN_INDICATORS`, `createIndicator`, `serializeIndicators`, `parseIndicatorDocument`, …).

`@fume/react`: props `indicators` (controlled; passing back the reported array is a no-op) and
`onIndicatorsChange`; handle methods `addIndicator`, `updateIndicator`, `removeIndicator`,
`getIndicators`. Configuration stays across symbol and timeframe switches (unlike drawings, which
the reference app keys per instrument); the values are recalculated from the new bars.

## Performance (benchmark `/?bench`, 1m SPY replay, 66,159 bars, DPR 1)

| Measurement                                   | Without indicators | With SMA 20, EMA 20, Volume, RSI 14  |
| --------------------------------------------- | ------------------ | ------------------------------------ |
| `setData` + first render (paired median of 5) | 142 ms             | 151 ms (full calculation ≈ 9 ms)     |
| Full repaint                                  | 0.9–1.7 ms         | 2.7–3.4 ms (two overlays, two panes) |
| Overlay-only repaint (crosshair)              | 0.1 ms             | 0.2 ms                               |
| Live bar upsert + repaint                     | 1.0 ms             | 2.1–2.4 ms (one position recomputed) |

## Extension points

Bollinger Bands, MACD, ATR, VWAP (session-anchored, needs session boundaries from the time scale),
pane resizing/reordering/merging, last-value axis labels, indicator-on-indicator inputs and
indicator undo are all additions to definitions, the layout input or the engine's command set;
none needs a new coordinate system or rendering layer.
