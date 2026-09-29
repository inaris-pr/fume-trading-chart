import { describe, expect, test } from 'vitest';
import {
  barAtSlot,
  beginDrag,
  computeCrosshair,
  dragDelta,
  endDrag,
  IDLE_DRAG,
  isInsidePlot,
} from '../src/interaction.ts';
import { buildFrame, DEFAULT_FRAME_SETTINGS } from '../src/frame.ts';
import { CandleBuffer } from '../src/geometry.ts';
import { indexSeries } from '../src/series.ts';
import { demoSeries } from './fakes.ts';

const view = { barSpacing: 7, rightOffset: 6 };

describe('drag state machine', () => {
  test('primary button starts a drag; move reports distance; release ends it', () => {
    let s = beginDrag(IDLE_DRAG, { pointerId: 7, x: 100, button: 0 }, view);
    expect(s.active).toBe(true);
    expect(dragDelta(s, { pointerId: 7, x: 160 })).toBe(60);
    expect(dragDelta(s, { pointerId: 7, x: 40 })).toBe(-60);
    s = endDrag(s, 7);
    expect(s).toEqual(IDLE_DRAG);
    expect(dragDelta(s, { pointerId: 7, x: 200 })).toBeNull();
  });

  test('secondary buttons do not start a drag', () => {
    expect(beginDrag(IDLE_DRAG, { pointerId: 1, x: 0, button: 2 }, view)).toBe(IDLE_DRAG);
  });

  test('another pointer cannot move or end the active drag', () => {
    const s = beginDrag(IDLE_DRAG, { pointerId: 1, x: 0, button: 0 }, view);
    expect(dragDelta(s, { pointerId: 2, x: 50 })).toBeNull();
    expect(endDrag(s, 2)).toBe(s);
    expect(beginDrag(s, { pointerId: 2, x: 0, button: 0 }, view)).toBe(s);
  });

  test('endDrag(null) always resets (used on cancellation / destroy)', () => {
    const s = beginDrag(IDLE_DRAG, { pointerId: 1, x: 0, button: 0 }, view);
    expect(endDrag(s, null)).toEqual(IDLE_DRAG);
  });

  test('the drag remembers the view it started from', () => {
    const s = beginDrag(
      IDLE_DRAG,
      { pointerId: 1, x: 0, button: 0 },
      { barSpacing: 9, rightOffset: -3 },
    );
    expect(s.active && s.kind === 'pan' && s.startView).toEqual({ barSpacing: 9, rightOffset: -3 });
  });
});

describe('crosshair model', () => {
  const data = demoSeries({ dropIndices: [756] });
  const series = indexSeries(data.bars, data.mapping);
  const frame = buildFrame(
    {
      cssWidth: 1000,
      cssHeight: 600,
      pixelRatio: 2,
      series,
      mapping: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      settings: { ...DEFAULT_FRAME_SETTINGS, priceAxisWidth: 70, minPriceStep: 0.01 },
    },
    new CandleBuffer(),
  );
  const at = (x: number, y: number) =>
    computeCrosshair({
      frame,
      series,
      mapping: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      pointer: { x, y },
    });

  test('vertical line snaps to the nearest slot; price follows the exact pointer y', () => {
    const slotX = frame.viewport.slotToX(750);
    for (const dx of [-3.4, 0, 3.4]) {
      const c = at(slotX + dx, 200)!;
      expect(c.slot).toBe(750);
      expect(c.x).toBe(slotX);
      expect(c.price).toBeCloseTo(frame.priceScale!.toPrice(200), 12);
      expect(c.priceText).toBe(data.formatPrice(c.price!));
    }
    expect(at(slotX + 3.6, 200)!.slot).toBe(751);
  });

  test('pointer y -> price uses the frame price scale (round trip)', () => {
    const price =
      frame.priceScale!.range.min +
      (frame.priceScale!.range.max - frame.priceScale!.range.min) * 0.3;
    const c = at(500, frame.priceScale!.toY(price))!;
    expect(c.price).toBeCloseTo(price, 9);
  });

  test('over a bar: returns that bar and an intraday date-time readout', () => {
    const c = at(frame.viewport.slotToX(750), 100)!;
    expect(c.bar).toBe(series.bars[750]);
    expect(c.timeText).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, 2026, \d\d:\d\d$/);
  });

  test('over an empty slot (gap): no bar, but time readout still shows the slot time', () => {
    const c = at(frame.viewport.slotToX(756), 100)!;
    expect(c.slot).toBe(756);
    expect(c.bar).toBeNull();
    expect(c.timeText).not.toBeNull();
    expect(barAtSlot(series, 756)).toBeNull();
    expect(barAtSlot(series, 757)).toBe(series.bars[756]);
  });

  test('outside the plot (price axis, time axis, off-canvas) => no crosshair', () => {
    const { plot } = frame.layout;
    expect(at(plot.width + 5, 100)).toBeNull(); // price axis
    expect(at(100, plot.height + 5)).toBeNull(); // time axis
    expect(at(-1, 100)).toBeNull();
    expect(isInsidePlot(frame, plot.width - 0.5, plot.height - 0.5)).toBe(true);
    expect(isInsidePlot(frame, plot.width, 10)).toBe(false);
  });

  test('slots beyond the resolved calendar get no time readout', () => {
    // demoSeries resolves sessions through 2026-03-20; slot 20 sessions ahead is extrapolated.
    const far = 780 + 20 * 78;
    expect(data.mapping.toSlot(data.mapping.slotStart(far))).toBeNull();
  });
});
