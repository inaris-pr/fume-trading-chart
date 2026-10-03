/**
 * Indicators through the real chart (fake browser, DPR 2): panes and layout, AUTO/fixed scaling,
 * painted geometry (overlay lines, histograms, pane lines), the incremental calculation lifecycle
 * (append, live updates, corrections, prepend, data replacement), the pane-aware crosshair and
 * legend, and the API's change-event semantics.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { calculateIndicator, EMA, RSI, SMA, type IndicatorInstance } from '@fume/indicators';
import { FumeChart } from '../src/chart.ts';
import { computeLayout, paneHeights } from '../src/layout.ts';
import { bar, demoSeries, FakeEnvironment, fakeContainer, pointer } from './fakes.ts';

const PR = 2;

function setup(bars = demoSeries().bars) {
  const env = new FakeEnvironment();
  env.dpr = PR;
  const data = demoSeries();
  const changes: { list: readonly IndicatorInstance[]; kind: string; id: string }[] = [];
  let n = 0;
  const chart = new FumeChart(
    fakeContainer(),
    {
      timeScale: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: 0.01,
      createIndicatorId: () => `i${++n}`,
      onIndicatorsChange: (list, change) => changes.push({ list, ...change }),
    },
    env,
  );
  env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
  chart.setBars(bars);
  env.flushFrames();
  const flush = () => env.flushFrames();
  const frame = () => chart.getLastFrame()!;
  const main = env.canvases[0]!.ctx;
  const overlay = env.canvases[1]!;
  /** Repaints and returns the main layer's recording. */
  const paint = () => {
    main.reset();
    chart.renderAll();
    return main;
  };
  return { env, data, chart, changes, flush, frame, main, overlay, paint };
}

/** Records the `from` of every calculator update of definition `def` (restored after each test). */
function spyUpdates(def: typeof SMA) {
  const calls: number[] = [];
  const original = def.createCalculator.bind(def);
  vi.spyOn(def, 'createCalculator').mockImplementation((params) => {
    const calc = original(params);
    const update = calc.update.bind(calc);
    calc.update = (bars, from, outputs) => {
      calls.push(from);
      update(bars, from, outputs);
    };
    return calc;
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

const strokesWithPoints = (ctx: ReturnType<typeof setup>['main']) =>
  ctx.strokes.filter((s) => s.points.length > 1);

describe('layout: N stacked panes over one time axis', () => {
  test('pane heights: fixed proportions, the main pane keeps at least half, sums are exact', () => {
    expect(paneHeights(500, 0)).toEqual([500]);
    expect(paneHeights(500, 1)).toEqual([400, 100]);
    expect(paneHeights(500, 2)).toEqual([300, 100, 100]);
    expect(paneHeights(500, 3)).toEqual([251, 83, 83, 83]);
    expect(paneHeights(1000, 1)).toEqual([840, 160]); // capped at 160
    expect(paneHeights(100, 2)).toEqual([50, 25, 25]); // small chart: shrink evenly
    expect(paneHeights(0, 2)).toEqual([0, 0, 0]);
    for (const [h, n] of [
      [777, 4],
      [123, 1],
      [61, 5],
    ] as const)
      expect(paneHeights(h, n).reduce((a, b) => a + b, 0)).toBe(h);
  });

  test('panes share the width, stack without gaps, and the time axis sits below the last one', () => {
    const l = computeLayout(1000, 600, 60, 26, 2);
    expect(l.panes).toHaveLength(3);
    expect(l.panes[0]!.plot).toBe(l.plot); // the main pane IS the plot drawings use
    let y = 0;
    for (const p of l.panes) {
      expect(p.plot).toMatchObject({ x: 0, y, width: 940 });
      expect(p.priceAxis).toMatchObject({ x: 940, y, width: 60, height: p.plot.height });
      y += p.plot.height;
    }
    expect(l.paneArea).toEqual({ x: 0, y: 0, width: 940, height: 574 });
    expect(l.timeAxis).toEqual({ x: 0, y: 574, width: 940, height: 26 });
  });

  test('overlays add no pane; each visible pane indicator gets one, in configuration order', () => {
    const t = setup();
    t.chart.addIndicator('sma');
    t.chart.addIndicator('ema');
    t.flush();
    expect(t.frame().panes).toHaveLength(0);
    const vol = t.chart.addIndicator('volume')!;
    t.chart.addIndicator('rsi');
    t.flush();
    const [volPane, rsiPane] = t.frame().panes;
    expect(volPane!.ticks.every((tick) => /K|M|^\d+$/.test(tick.text))).toBe(true);
    expect(rsiPane!.priceScale!.range).toEqual({ min: 0, max: 100 });
    t.chart.updateIndicator(vol, { visible: false });
    t.flush();
    expect(t.frame().panes).toHaveLength(1); // hidden pane indicators take no pane
    expect(t.frame().panes[0]!.priceScale!.range).toEqual({ min: 0, max: 100 });
  });

  test('resize recomputes the panes for the new height', () => {
    const t = setup();
    t.chart.addIndicator('rsi');
    t.flush();
    t.env.resizeCallback!({ cssWidth: 800, cssHeight: 400 });
    t.flush();
    const [mainH, rsiH] = paneHeights(400 - 26, 1);
    expect(t.frame().layout.plot.height).toBe(mainH);
    expect(t.frame().panes[0]!.plot).toMatchObject({
      y: mainH,
      height: rsiH,
      width: t.frame().layout.plot.width,
    });
  });
});

describe('scaling', () => {
  // 400 bars around 200, then 380 bars around 100: a long SMA stays far above the visible candles.
  const stepBars = () =>
    demoSeries().bars.map((b, i) => {
      const base = i < 400 ? 200 : 100;
      return bar(b.start, base, base + 0.5, base - 0.5, base);
    });

  test('visible price overlays widen the main AUTO range; hidden ones do not', () => {
    const t = setup(stepBars());
    const before = t.frame().priceScale!.range;
    expect(before.max).toBeLessThan(110);
    const id = t.chart.addIndicator('sma', { params: { period: 400 } })!;
    t.flush();
    const visibleSma = t.chart.getIndicatorValues(id)!.value!;
    expect(visibleSma).toBeGreaterThan(before.max); // above every visible candle
    expect(t.frame().priceScale!.range.max).toBeGreaterThanOrEqual(visibleSma);
    t.chart.updateIndicator(id, { visible: false });
    t.flush();
    expect(t.frame().priceScale!.range).toEqual(before);
  });

  test('a MANUAL price scale stays under the user’s control', () => {
    const t = setup(stepBars());
    const plot = t.frame().layout.plot;
    t.overlay.dispatch('wheel', {
      offsetX: plot.width + 10,
      offsetY: 200,
      deltaX: 0,
      deltaY: 200,
      deltaMode: 0,
      ctrlKey: false,
    });
    t.flush();
    const manual = t.frame().priceScale!.range;
    t.chart.addIndicator('sma', { params: { period: 400 } });
    t.flush();
    expect(t.chart.getPriceScaleMode()).toBe('manual');
    expect(t.frame().priceScale!.range).toEqual(manual);
  });

  test('Volume: 0 .. visible max (with headroom); RSI: fixed 0..100 with 30/70 guides', () => {
    const t = setup();
    t.chart.addIndicator('volume');
    t.chart.addIndicator('rsi');
    t.flush();
    const f = t.frame();
    const [vol, rsi] = f.panes;
    let max = 0;
    for (let i = Math.max(0, f.visible.from); i < f.visible.to; i++)
      max = Math.max(max, t.data.bars[i]!.volume);
    expect(vol!.priceScale!.range.min).toBe(0);
    expect(vol!.priceScale!.range.max).toBeCloseTo(max * 1.1, 6);
    expect(vol!.priceScale!.toY(0)).toBeCloseTo(vol!.plot.y + vol!.plot.height - 4, 6);
    expect(rsi!.priceScale!.toY(100)).toBeCloseTo(rsi!.plot.y + 4, 6);
    expect(rsi!.guides.map((g) => g.value)).toEqual([30, 70]);
    expect(rsi!.guides[0]!.y).toBeCloseTo(rsi!.priceScale!.toY(30), 9);
    expect(rsi!.ticks.map((tk) => tk.text)).toEqual(['30', '70']);
  });
});

describe('rendering', () => {
  test('overlay line: points at the candle centers and the indicator values (device px)', () => {
    const t = setup();
    const id = t.chart.addIndicator('sma', { params: { period: 10 } })!;
    const ctx = t.paint();
    const line = strokesWithPoints(ctx).find((s) => s.style === '#f5a623')!;
    const f = t.frame();
    const c = t.chart.getCoordinates()!;
    const last = t.data.bars.at(-1)!;
    const lastPoint = line.points.at(-1)!;
    expect(lastPoint.x).toBeCloseTo(c.timeToX(last.start)! * PR, 6);
    expect(lastPoint.y).toBeCloseTo(c.priceToY(t.chart.getIndicatorValues(id)!.value!) * PR, 6);
    // Only the visible range (plus one bar each side) is painted.
    expect(line.points.length).toBe(Math.min(f.visible.to, 780) - Math.max(f.visible.from, 9));
  });

  test('session-compressed alignment: pane lines use exactly the candles’ x positions', () => {
    const t = setup();
    t.chart.addIndicator('sma', { params: { period: 5 } });
    t.chart.addIndicator('rsi', { params: { period: 5 } });
    const lines = strokesWithPoints(t.paint());
    const sma = lines.find((s) => s.style === '#f5a623')!;
    const rsi = lines.find((s) => s.style === '#b36bff')!;
    expect(rsi.points.map((p) => p.x)).toEqual(sma.points.map((p) => p.x));
    // RSI points stay inside the RSI pane (independent scale).
    const pane = t.frame().panes[0]!.plot;
    for (const p of rsi.points) {
      expect(p.y).toBeGreaterThanOrEqual(pane.y * PR);
      expect(p.y).toBeLessThanOrEqual((pane.y + pane.height) * PR);
    }
  });

  test('histogram: one direction-colored bar per visible candle from the zero line', () => {
    const t = setup();
    t.chart.addIndicator('volume');
    const ctx = t.paint();
    const f = t.frame();
    const bars = ctx.rects.filter(
      (r) => r.style === 'rgba(38, 178, 122, 0.55)' || r.style === 'rgba(226, 72, 77, 0.55)',
    );
    expect(bars.length).toBe(Math.min(f.visible.to, 780) - Math.max(f.visible.from, 0));
    const zero = Math.round(f.panes[0]!.priceScale!.toY(0) * PR);
    for (const r of bars) expect(r.y + r.h).toBe(zero);
  });

  test('warm-up: nothing is painted before an indicator has enough bars', () => {
    const t = setup(demoSeries().bars.slice(0, 30));
    t.chart.addIndicator('sma', { params: { period: 50 } });
    t.chart.addIndicator('rsi', { params: { period: 40 } });
    expect(strokesWithPoints(t.paint())).toEqual([]);
    expect(t.chart.getIndicatorValues(t.chart.getIndicators()[0]!.id)).toEqual({ value: null });
  });
});

describe('calculation lifecycle', () => {
  test('values equal a full calculation over the chart’s bars', () => {
    const t = setup();
    const ids = ['sma', 'ema', 'rsi'].map((type) => t.chart.addIndicator(type)!);
    t.flush();
    const bars = t.data.bars;
    const defs = [SMA, EMA, RSI];
    ids.forEach((id, k) => {
      const want = calculateIndicator(defs[k]!, { period: k === 2 ? 14 : 20 }, bars).value!;
      for (const i of [0, 19, 20, 400, 779])
        expect(t.chart.getIndicatorValues(id, bars[i]!.start)!.value).toBe(want[i]);
    });
  });

  test('a live bar recomputes only the last position; provisional updates re-run it', () => {
    const calls = spyUpdates(EMA);
    const t = setup();
    const id = t.chart.addIndicator('ema')!;
    t.flush();
    expect(calls).toEqual([0]);
    const last = t.data.bars.at(-1)!;
    const next = t.data.mapping.slotStart(t.data.mapping.toSlot(last.start)! + 1);
    t.chart.upsertBars([bar(next, last.close, last.close + 1, last.close - 1, last.close + 0.5)]);
    t.flush();
    t.chart.upsertBars([bar(next, last.close, last.close + 2, last.close - 1, last.close + 1.5)]);
    t.flush();
    expect(calls).toEqual([0, 780, 780]); // appended, then the provisional bar changed
    const all = [
      ...t.data.bars,
      bar(next, last.close, last.close + 2, last.close - 1, last.close + 1.5),
    ];
    expect(t.chart.getIndicatorValues(id)!.value).toBe(
      calculateIndicator(EMA, { period: 20 }, all).value!.at(-1),
    );
  });

  test('a corrected older bar recomputes the recursive suffix from that bar on', () => {
    const calls = spyUpdates(EMA);
    const t = setup();
    const id = t.chart.addIndicator('ema')!;
    t.flush();
    const old = t.data.bars[500]!;
    const fixed = bar(old.start, old.open, old.high + 5, old.low, old.close + 3);
    t.chart.upsertBars([fixed]);
    t.flush();
    expect(calls).toEqual([0, 500]);
    const all = t.data.bars.map((b, i) => (i === 500 ? fixed : b));
    const want = calculateIndicator(EMA, { period: 20 }, all).value!;
    for (const i of [499, 500, 600, 779])
      expect(t.chart.getIndicatorValues(id, all[i]!.start)!.value).toBe(want[i]);
  });

  test('prepended history recomputes everything (positions shift, seeds may improve)', () => {
    const calls = spyUpdates(RSI);
    const all = demoSeries().bars;
    const t = setup(all.slice(390));
    const id = t.chart.addIndicator('rsi')!;
    t.flush();
    t.chart.prependBars(all.slice(0, 390));
    t.flush();
    expect(calls).toEqual([0, 0]);
    const want = calculateIndicator(RSI, { period: 14 }, all).value!;
    for (const i of [14, 389, 390, 779])
      expect(t.chart.getIndicatorValues(id, all[i]!.start)!.value).toBe(want[i]);
  });

  test('a data replacement (symbol/timeframe switch) keeps the configuration, drops stale values', () => {
    const t = setup();
    const id = t.chart.addIndicator('sma', { params: { period: 5 } })!;
    t.flush();
    const config = t.chart.getIndicators();
    const other = demoSeries().bars.map((b) => bar(b.start, 50, 51, 49, 50));
    t.chart.setData({
      bars: other,
      timeScale: t.data.mapping,
      formatPrice: t.data.formatPrice,
      formatTime: t.data.formatTime,
      minPriceStep: 0.01,
    });
    t.flush();
    expect(t.chart.getIndicators()).toBe(config);
    expect(t.chart.getIndicatorValues(id)).toEqual({ value: 50 });
    t.chart.setBars(other.slice(0, 3)); // fewer bars than the period: no value at all
    t.flush();
    expect(t.chart.getIndicatorValues(id)).toEqual({ value: null });
  });

  test('pointer movement and crosshair painting never recalculate indicators', () => {
    const calls = spyUpdates(SMA);
    const t = setup();
    t.chart.addIndicator('sma');
    t.flush();
    const before = calls.length;
    for (let x = 50; x < 900; x += 37) t.overlay.dispatch('pointermove', pointer(x, 200));
    t.flush();
    expect(calls.length).toBe(before);
  });
});

describe('crosshair and legend', () => {
  test('the vertical line spans every pane; the readout uses the pane under the pointer', () => {
    const t = setup();
    t.chart.addIndicator('volume');
    t.chart.addIndicator('rsi');
    t.flush();
    const rsiPane = t.frame().panes[1]!;
    const y = rsiPane.priceScale!.toY(50);
    t.overlay.dispatch('pointermove', pointer(500, y));
    t.flush();
    const ch = t.chart.getCrosshair()!;
    expect(ch.pane).toBe(2);
    expect(Number(ch.priceText)).toBeCloseTo(50, 0);
    const ctx = t.overlay.ctx;
    const vertical = ctx.rects.filter((r) => r.x === Math.round(ch.x * PR) && r.w <= PR);
    expect(Math.max(...vertical.map((r) => r.y + r.h))).toBeGreaterThan(rsiPane.plot.y * PR);
    // Price readout box inside the RSI pane's axis band.
    const box = ctx.rects.find(
      (r) => r.x > t.frame().layout.plot.width * PR && r.style === '#3a4150',
    )!;
    expect(box.y).toBeGreaterThanOrEqual(rsiPane.plot.y * PR);
  });

  test('legend rows show each visible indicator’s value at the crosshair bar', () => {
    const t = setup();
    const sma = t.chart.addIndicator('sma')!;
    t.chart.addIndicator('rsi');
    t.flush();
    const target = t.data.bars[760]!;
    const x = t.chart.getCoordinates()!.timeToX(target.start)!;
    t.overlay.dispatch('pointermove', pointer(x, 100));
    t.flush();
    const texts = t.overlay.ctx.texts.map((tx) => tx.text);
    expect(texts).toContain('SMA 20');
    expect(texts).toContain('RSI 14');
    const value = t.chart.getIndicatorValues(sma, target.start)!.value!;
    expect(texts).toContain(t.data.formatPrice(value));
  });
});

describe('API', () => {
  test('add / update / remove are user commands (events); setIndicators is not echoed', () => {
    const t = setup();
    const a = t.chart.addIndicator('sma')!;
    expect(t.chart.updateIndicator(a, { params: { period: 50 } })).toBe(true);
    expect(t.chart.updateIndicator(a, { params: { period: 50 } })).toBe(false); // no change
    expect(t.chart.updateIndicator(a, { params: { period: 0 } })).toBe(false); // invalid
    expect(t.chart.addIndicator('macd')).toBeNull();
    expect(t.chart.addIndicator('rsi', { params: { period: 1.5 } })).toBeNull();
    expect(t.chart.removeIndicator(a)).toBe(true);
    expect(t.changes.map((c) => `${c.kind}:${c.id}`)).toEqual(['add:i1', 'update:i1', 'remove:i1']);
    expect(t.changes[1]!.list).not.toBe(t.changes[0]!.list);

    const host: IndicatorInstance[] = [
      {
        id: 'h1',
        type: 'ema',
        params: { period: 9 },
        style: { color: '#fff', lineWidth: 1 },
        visible: true,
      },
    ];
    t.chart.setIndicators(host);
    expect(t.chart.getIndicators()).toBe(host); // valid: kept as given
    expect(t.changes).toHaveLength(3); // not echoed
    t.chart.setIndicators([...host, { ...host[0]!, id: 'bad', params: { period: -1 } }]);
    expect(t.chart.getIndicators().map((i) => i.id)).toEqual(['h1']); // invalid left out
  });

  test('hidden indicators: no plot, no legend row, no values', () => {
    const t = setup();
    const id = t.chart.addIndicator('sma', { visible: false })!;
    expect(strokesWithPoints(t.paint())).toEqual([]);
    t.overlay.dispatch('pointermove', pointer(500, 100));
    t.flush();
    expect(t.overlay.ctx.texts.map((x) => x.text)).not.toContain('SMA 20');
    expect(t.chart.getIndicatorValues(id)).toBeNull();
  });

  test('destroy: commands refused, no events afterwards', () => {
    const t = setup();
    t.chart.addIndicator('sma');
    t.chart.destroy();
    expect(t.chart.addIndicator('ema')).toBeNull();
    expect(t.chart.removeIndicator('i1')).toBe(false);
    expect(t.changes).toHaveLength(1);
    expect(t.overlay.listenerCount()).toBe(0);
  });
});
