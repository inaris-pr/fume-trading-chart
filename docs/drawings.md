# Drawings and overlays

Status: **Stage 7 "drawing foundation"** (2026-10-01, uncommitted). The drawing system lives in the
chart engine (`packages/chart/src/drawings/`, `packages/chart/src/coordinates.ts`); the React
wrapper only passes it through, and the reference app adds a toolbar. Implemented: trend line
(complete vertical slice), horizontal line, rectangle. Not yet: other tools (see "Extension
points"), styling UI, persistence (host-owned by design).

## Architecture

```
FumeChart
├─ main canvas        grid, candles, axes, last price          repainted on data/view/size change
├─ drawing canvas     drawings, hover, handles, preview         repainted on view change or drawing change
└─ overlay canvas     crosshair, readouts, OHLC legend          repainted on every pointer move; receives
                                                                all pointer, wheel and key events
```

- **Drawings never paint into the candle layer.** Their own canvas (`pointer-events: none`) sits
  between candles and crosshair. A hover, selection, drag or preview change repaints only that
  canvas from the last frame; the candle frame is not rebuilt. A view change (zoom, pan, price
  scale, resize, live bar, paging) rebuilds the frame and then repaints drawings from it.
- **Canvas 2D, not DOM/SVG.** The geometry is a handful of segments per drawing, recomputed per
  frame from market coordinates, so a canvas layer is cheaper and stays pixel-identical to the
  candle transform (same frame, same viewport, same price scale). Hit-testing is done in code, not
  by the browser, so there is no DOM node per drawing.
- **Modules** (pure unless noted):

| Module                   | Role                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `coordinates.ts`         | Public coordinate system of a rendered frame (time/price ↔ x/y)                    |
| `drawings/model.ts`      | Versioned, serializable drawing model; `serializeDrawings`, `parseDrawingDocument` |
| `drawings/geometry.ts`   | Anchors → screen shapes and handles; `moveHandle`, `translateDrawing`              |
| `drawings/hit-test.ts`   | Screen-space hit-testing (handle / body / empty)                                   |
| `drawings/controller.ts` | Tool/interaction state machine + the drawing set (framework-free, no DOM)          |
| `drawings/paint.ts`      | Paints the drawing canvas (the only module touching a 2D context)                  |
| `chart.ts`               | Owns the canvas, routes pointer/key input to the controller, schedules repaints    |

No React re-render happens during pointer movement: hover, preview and drags stay inside the
engine; events reach the host once per completed user action.

## Drawing model (`DRAWING_SCHEMA_VERSION = 1`)

```ts
interface Drawing {
  id: string; // unique per drawing set; chart default crypto.randomUUID()
  type: 'trend-line' | 'horizontal-line' | 'rectangle';
  anchors: { time: UnixMs; price: number }[]; // market coordinates, never pixels or bar indices
  style: {
    color: string;
    lineWidth: number;
    lineStyle: 'solid' | 'dashed' | 'dotted';
    fillColor?: string;
  };
  visible: boolean; // hidden: not painted, not hit-tested
  locked: boolean; // selectable, but not movable, reshapable or deletable by the user
}
```

| Type              | Anchors | Meaning                                                       |
| ----------------- | ------- | ------------------------------------------------------------- |
| `trend-line`      | 2       | End points                                                    |
| `horizontal-line` | 1       | Price; the anchor time only places the handle                 |
| `rectangle`       | 2       | Opposite corners (time range × price range); 4 corner handles |

- **Not in the model:** selection, hover, an unfinished drawing. They are interaction state.
- **Persisted form** (`serializeDrawings`): `{ format: 'fume.drawings', version: 1, drawings }`,
  fixed key order, model fields only, so equal drawings serialize to identical JSON (a test pins
  the exact JSON of version 1). `parseDrawingDocument(unknown)` validates untrusted data and throws
  `DrawingSchemaError` for another format, an unknown version, an unknown type, a wrong anchor
  count, non-finite numbers, invalid styles or duplicate ids. It never guesses or silently drops.
  Any incompatible change to the shape bumps the version.

## Coordinate model

All drawing geometry is stored as **time + price** and converted per frame through the public
`ChartCoordinates` (`chart.getCoordinates()`, a new object after each frame):

| Method                                      | Meaning                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `timeToX(time)`                             | x of a time; null outside the resolved calendar                            |
| `xToTime(x)`                                | exact time under x (inside a bar: proportional); null outside the calendar |
| `xToBarTime(x)`                             | open time of the nearest bar slot (the anchor snapping)                    |
| `priceToY(price)` / `yToPrice`              | the active price scale (AUTO or MANUAL), exactly as candles use it         |
| `timeToSlot` / `slotToTime`                 | the underlying continuous slot coordinate                                  |
| `slotToX` / `xToSlot`, `plot`, `barSpacing` | viewport primitives for overlays                                           |

Time goes through two methods on `TimeScaleMapping` (`@fume/core`), built from the same resolved
sessions as the candles:

- `timeToSlotCoordinate(t)`: a bar's open time is its integer slot (its candle center); time inside
  a bar moves linearly towards the next bar's center (a clipped slot, e.g. 1H 15:30–16:00, is
  proportionally shorter in time).
- `slotCoordinateToTime(s)`: the exact inverse, returning real open-market time.

Because anchors are times, a drawing is **independent of the timeframe**. A 1m anchor at 11:07
sits at 2/5 of the 11:05 bar on 5m and at 37/60 of the 10:30 bar on 1H, so a drawing stays
geometrically correct on every timeframe whose calendar covers its anchors. Anchors are never
converted to bar indices.

### Session gaps (snapping policy)

- **Closed time has zero width.** A timestamp in a scheduled closed period (overnight, weekend,
  holiday, the CME 16:00–17:00 CT break, pre/post-market on an RTH chart) is drawn at the first open
  slot after it, the same x as the session close. Continuous, monotonic, and never fabricated:
  the stored anchor keeps its real timestamp.
- **User input snaps to bars.** Placing or dragging a handle snaps the time to the open time of
  the nearest bar slot (real session time); the price is exact (no magnet yet).
- **Whole-drawing moves shift by whole bars** of the current timeframe (each anchor keeps its
  position inside its bar) plus a price delta. A move across a gap lands on real open time on the
  other side.
- **Outside the resolved calendar** (before the oldest loaded history's sessions, or beyond the
  ~14 days of future sessions the DataFeed resolves), a time has no position on a
  session-compressed axis. `timeToX` returns null, such drawings are not painted or hit, and clicks
  there do not create anchors. Nothing is extrapolated. The drawing is still stored unchanged and
  appears again once history covering it is paged in.

## Ownership and persistence

- **The engine owns** rendering, hit-testing, the tool state machine and the in-memory drawing set
  of one chart.
- **The host owns persistence.** `onDrawingsChange(drawings, change)` reports the complete new set
  after every user edit (`change = { kind: 'add' | 'update' | 'remove', id }`), once per edit and
  never per pointer move. The host stores it (e.g. `serializeDrawings`) and restores it with
  `setDrawings`. `setDrawings` is not echoed back, so a controlled `drawings` prop cannot loop.
- **Per symbol:** the engine keeps whatever set it is given across `setData` (timeframe and symbol
  switches). Keying drawings by instrument is the host's choice; the reference app keeps them in
  memory per instrument and passes the right set on a switch. An unfinished drawing or a drag is
  cancelled when the chart's data is replaced.

### `@fume/chart` API

```ts
chart.setDrawings(drawings); // replace (host data; no change event)
chart.getDrawings(); // current set, z-order bottom first (replaced, never mutated)
chart.setDrawingTool('trend-line' | 'horizontal-line' | 'rectangle' | 'cursor');
chart.getDrawingTool();
chart.selectDrawing(id | null);
chart.getSelectedDrawingId();
chart.getCoordinates(); // ChartCoordinates | null
chart.getDrawingInteractionState(); // inspection: idle / drawing / dragging-*
// FumeChartOptions: onDrawingsChange, onDrawingToolChange, onDrawingSelectionChange, createDrawingId
```

`add/update/remove/clearDrawings` were left out deliberately: the host composes them over
`getDrawings()` + `setDrawings()` (immutable arrays), which keeps one write path and one rule
("host writes are not echoed"). Model helpers are exported too: `serializeDrawings`,
`parseDrawingDocument`, `DrawingSchemaError`, `DRAWING_SCHEMA_VERSION`, `ANCHOR_COUNT`.

### `@fume/react`

`<FumeChartView drawings onDrawingsChange onDrawingToolChange onDrawingSelectionChange />` plus
handle methods `setDrawingTool`, `getDrawingTool`, `getDrawings` (docs/embedding.md). The wrapper
holds no drawing logic and no drawing state.

## Interaction state machine (`DrawingController`)

```
            setTool(type)                      last anchor placed
   idle ───────────────────▶ drawing ────────────────────────────────▶ idle (+ add, select new,
    ▲  ▲                      │  ▲ anchor placed (needs more)                tool back to cursor)
    │  │     Escape / setTool('cursor')        └──┘
    │  └────────────────────────┘
    │ press on handle (selected, unlocked)     press on body (unlocked)
    ├──────────────▶ dragging-handle           ├──────────────▶ dragging-drawing
    │                  │ move: reshape          │                 │ move: translate
    └──── release: update event (if moved) ◀────┴──── Escape / pointercancel: revert, no event
```

- **idle** (cursor tool): press on a drawing selects it (and starts a drag unless locked); press
  on empty space clears the selection and is **not consumed**, so the chart pans. Hover is tracked
  for highlighting and the cursor (`pointer` on a body, `move` on a handle).
- **drawing** (a drawing tool is active): each primary press places an anchor at the snapped
  position. Two-anchor tools also accept press-drag-release (drag-to-create, beyond 6 px). The
  preview follows the pointer. A second click within 3 px of the first anchor is ignored (no
  zero-length drawings). Finishing adds the drawing, selects it and returns the tool to `cursor`
  (one drawing per activation). `Escape` cancels the unfinished drawing and returns to the cursor.
- **dragging-handle / dragging-drawing**: only the pressing pointer moves the drawing; other
  pointers are swallowed (no pan). Nothing is reported during the drag; release reports one
  `update`. `Escape` or `pointercancel` reverts to the original drawing without an event.
- **Keyboard** (the overlay canvas takes focus on a press in the plot; it is focusable from script
  only, not a tab stop): `Delete`/`Backspace` removes the selected unlocked drawing (one `remove`
  event); `Escape` cancels/deselects. The reference app also maps `Escape` globally while a tool is
  active, because the toolbar button may hold the focus.
- Non-primary buttons never create or move drawings; presses outside the plot (price axis) keep
  their chart meaning (price scaling).

## Hit-testing rules (`hitTestDrawings`)

Screen space (CSS px), always against the current frame's geometry, so it keeps working after
zoom, pan, resize and price scaling. Only points inside the plot can hit.

1. **Handles** of the selected, unlocked drawing: the nearest handle within 9 px (painted radius
   5 px) wins over everything.
2. **Bodies**, from the top of the z-order (last drawn) down: within 6 px + half the line width of
   a segment (distance clamped to the segment ends), of a horizontal line's y, or of a rectangle's
   edge; a filled rectangle is also hit anywhere inside.
3. Otherwise **empty space** (null).

## Performance

- Geometry is memoized per (frame, drawing set); pointer moves without a view change reuse it for
  hit-testing.
- A hover or drag repaints only the drawing canvas (clear + a few paths); the candle frame is not
  rebuilt (tested: no main-canvas calls on hover).
- Visible drawings are painted in O(n); each anchor costs one binary search over the session
  segments.

## Extension points

| Feature                | How it fits                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rays / extended lines  | A `trend-line` style flag (`extend: 'none' \| 'right' \| 'both'`) or new types; geometry clips the extended segment to the plot.                                                                                                                                          |
| Parallel channel       | New type with 3 anchors (two points + offset); geometry yields two segments + fill; handles per anchor.                                                                                                                                                                   |
| Fibonacci retracement  | New type with 2 anchors; geometry derives level prices from the two anchor prices (levels in the style); painted as horizontal segments + labels.                                                                                                                         |
| Text / note            | New type with 1 anchor + `text` field; needs a text-measuring geometry step (bounding box for hit-testing).                                                                                                                                                               |
| Measurement tool       | Transient (not persisted) 2-anchor overlay reusing the controller's `drawing` state; labels from `formatPrice`/`formatTime` and bar counts via `timeToSlot`.                                                                                                              |
| AI annotations         | Host-supplied, typically `locked` drawings (or a separate read-only overlay set) in the same market coordinates; no new coordinate code.                                                                                                                                  |
| Trade / order overlays | Read-only horizontal lines and markers at prices/times from the trading projection, painted on the drawing canvas (or a sibling layer) through `ChartCoordinates`; dragging an order line would be a new controller state reporting intents, never placing orders itself. |
| Indicators             | Use `ChartCoordinates` (time/slot → x, price → y) for their own layer; not drawings.                                                                                                                                                                                      |

Adding a type means: a schema entry (bump the version if the persisted shape changes
incompatibly), `ANCHOR_COUNT`, geometry, hit-test shape, painter case and tests. The controller,
the coordinate system and the public API stay unchanged.

## Known limitations

- Drawings whose anchors lie outside the resolved calendar are hidden until history covering them
  is loaded (no extrapolation, see "Session gaps").
- No price magnet/snapping to OHLC, no styling UI, no z-order editing, no multi-select, no undo.
- Touch: pointer events work, but there is no long-press/touch-specific handling yet.
- Persistence, per-account storage and sharing are host concerns (not implemented in Fume yet).
