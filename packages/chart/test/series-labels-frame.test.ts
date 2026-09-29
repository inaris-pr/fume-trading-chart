import { describe, expect, test } from 'vitest';
import { indexSeries, visibleIndexRange } from '../src/series.ts';
import { buildTimeAxis } from '../src/time-labels.ts';
import { createViewport } from '../src/viewport.ts';
import { buildFrame, DEFAULT_FRAME_SETTINGS, type FrameInput } from '../src/frame.ts';
import { CandleBuffer } from '../src/geometry.ts';
import { bar, demoSeries } from './fakes.ts';

describe('indexSeries / visibleIndexRange', () => {
  const { bars, mapping } = demoSeries({ dropIndices: [756] });

  test('each bar gets its slot; a dropped bar leaves an empty slot', () => {
    const s = indexSeries(bars, mapping);
    expect(s.bars).toHaveLength(779);
    expect(s.unmappedCount).toBe(0);
    expect(s.slots[755]).toBe(755);
    expect(s.slots[756]).toBe(757); // slot 756 has no bar
  });

  test('bars in closed time are counted and skipped, not guessed', () => {
    const closed = bar(Date.UTC(2026, 2, 7, 15, 0), 1, 1, 1, 1); // Saturday
    const s = indexSeries([bars[0]!, closed, bars[1]!], mapping);
    expect(s.bars).toHaveLength(2);
    expect(s.unmappedCount).toBe(1);
  });

  test('unsorted or duplicate bars are rejected', () => {
    expect(() => indexSeries([bars[1]!, bars[0]!], mapping)).toThrow(/ascending/);
    expect(() => indexSeries([bars[0]!, bars[0]!], mapping)).toThrow(/ascending/);
  });

  test('visible range is a half-open index range by slot', () => {
    const s = indexSeries(bars, mapping);
    expect(visibleIndexRange(s.slots, 750, 760)).toEqual({ from: 750, to: 760 }); // slots 750..755, 757..760
    expect(visibleIndexRange(s.slots, 2000, 3000)).toEqual({ from: 779, to: 779 });
  });
});

describe('buildTimeAxis', () => {
  const { mapping, formatTime } = demoSeries();
  const viewport = createViewport({
    plotLeft: 0,
    plotWidth: 1200,
    barSpacing: 7,
    anchorSlot: 779,
    rightOffset: 6,
  });
  const axis = buildTimeAxis({
    mapping,
    viewport,
    formatTime,
    minLabelSpacing: 84,
    edgeMargin: 18,
  });

  test('session starts are labelled with the date; intraday labels fall on session-aligned hours', () => {
    const texts = axis.labels.map((l) => l.text);
    expect(texts).toContain('Mar 13');
    const times = texts.filter((t) => /^\d\d:\d\d$/.test(t));
    expect(times.length).toBeGreaterThan(3);
    // 5m slots, 12-slot (60 min) step from the 09:30 open => hh:30 labels.
    expect(times.every((t) => t.endsWith(':30'))).toBe(true);
  });

  test('labels never collide and stay inside the plot', () => {
    for (let i = 1; i < axis.labels.length; i++) {
      expect(axis.labels[i]!.x - axis.labels[i - 1]!.x).toBeGreaterThanOrEqual(84);
    }
    for (const l of axis.labels) {
      expect(l.x).toBeGreaterThanOrEqual(18);
      expect(l.x).toBeLessThanOrEqual(1200 - 18);
    }
  });

  test('a separator sits half a slot before each visible session start', () => {
    expect(axis.slotDurationMs).toBe(5 * 60_000);
    expect(axis.separators).toContain(viewport.slotToX(702) - 3.5); // Mar 13 open (slot 9 x 78)
    expect(axis.separators).toContain(viewport.slotToX(780) - 3.5); // next session (right offset)
  });

  test('wide spacing uses shorter intraday steps', () => {
    const wide = createViewport({
      plotLeft: 0,
      plotWidth: 1200,
      barSpacing: 30,
      anchorSlot: 779,
      rightOffset: 6,
    });
    const a = buildTimeAxis({
      mapping,
      viewport: wide,
      formatTime,
      minLabelSpacing: 84,
      edgeMargin: 18,
    });
    const times = a.labels.map((l) => l.text).filter((t) => /^\d\d:\d\d$/.test(t));
    expect(times.some((t) => t.endsWith(':45') || t.endsWith(':00') || t.endsWith(':15'))).toBe(
      true,
    );
  });
});

describe('buildFrame', () => {
  const data = demoSeries({ dropIndices: [756] });
  const input = (overrides: Partial<FrameInput> = {}): FrameInput => ({
    cssWidth: 1000,
    cssHeight: 600,
    pixelRatio: 2,
    series: indexSeries(data.bars, data.mapping),
    mapping: data.mapping,
    formatPrice: data.formatPrice,
    formatTime: data.formatTime,
    settings: { ...DEFAULT_FRAME_SETTINGS, priceAxisWidth: 70, minPriceStep: 0.01 },
    ...overrides,
  });

  test('draws one candle per visible bar, in device pixels', () => {
    const frame = buildFrame(input(), new CandleBuffer());
    const { from, to } = frame.visible;
    expect(frame.candles.count).toBe(to - from);
    expect(to).toBe(779);
    for (let i = 0; i < frame.candles.count; i++) {
      expect(frame.candles.bodyWidth[i]).toBe(8); // 7 CSS px * DPR 2 * 0.7, even parity
      expect(frame.candles.wickWidth[i]).toBe(2);
    }
  });

  test('the dropped bar leaves a two-slot gap between its neighbours', () => {
    const frame = buildFrame(input(), new CandleBuffer());
    const c = frame.candles;
    const xs = Array.from({ length: c.count }, (_, i) => c.wickX[i]!);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(gaps.filter((g) => g === 28)).toHaveLength(1); // 2 slots * 7 px * DPR 2
    expect(gaps.filter((g) => g !== 14 && g !== 28)).toHaveLength(0);
  });

  test('price scale covers every visible candle; ticks are inside the plot', () => {
    const frame = buildFrame(input(), new CandleBuffer());
    const c = frame.candles;
    const plotH = frame.layout.plot.height * 2;
    for (let i = 0; i < c.count; i++) {
      expect(c.wickY[i]).toBeGreaterThanOrEqual(0);
      expect(c.wickY[i]! + c.wickHeight[i]!).toBeLessThanOrEqual(plotH);
    }
    expect(frame.priceTicks.length).toBeGreaterThan(4);
    for (const t of frame.priceTicks) {
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThanOrEqual(frame.layout.plot.height);
      expect(t.text).toMatch(/^\d+\.\d\d$/);
    }
  });

  test('last price marker uses the latest bar close', () => {
    const frame = buildFrame(input(), new CandleBuffer());
    const last = data.bars[data.bars.length - 1]!;
    expect(frame.lastPrice?.price).toBe(last.close);
    expect(frame.lastPrice?.text).toBe(data.formatPrice(last.close));
    expect(frame.lastPrice?.y).toBeCloseTo(frame.priceScale!.toY(last.close), 12);
  });

  test('no data or no space => no scale, no candles, no crash', () => {
    const empty = buildFrame(input({ series: indexSeries([], data.mapping) }), new CandleBuffer());
    expect(empty.priceScale).toBeNull();
    expect(empty.candles.count).toBe(0);
    const tiny = buildFrame(input({ cssWidth: 50, cssHeight: 20 }), new CandleBuffer());
    expect(tiny.priceScale).toBeNull();
  });
});
