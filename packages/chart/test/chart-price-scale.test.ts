/**
 * Manual vertical price scaling (price-axis drag / wheel / double-click) through the chart's real
 * event listeners with a fake browser environment.
 */
import { describe, expect, test } from 'vitest';
import { FumeChart } from '../src/chart.ts';
import { demoSeries, FakeEnvironment, fakeContainer, pointer } from './fakes.ts';

function setup() {
  const env = new FakeEnvironment();
  env.dpr = 2;
  const data = demoSeries({ dropIndices: [756] });
  const chart = new FumeChart(
    fakeContainer(),
    {
      timeScale: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: 0.01,
    },
    env,
  );
  env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
  chart.setBars(data.bars);
  env.flushFrames();
  const overlay = env.canvases[1]!;
  const frame = () => chart.getLastFrame()!;
  const axisX = frame().layout.priceAxis.x + 10;
  const range = () => ({ ...frame().priceScale!.range });
  const span = () => frame().priceScale!.range.max - frame().priceScale!.range.min;
  const wheel = (x: number, y: number, deltaY: number, deltaX = 0) =>
    overlay.dispatch('wheel', {
      offsetX: x,
      offsetY: y,
      deltaX,
      deltaY,
      deltaMode: 0,
      ctrlKey: false,
    });
  const axisDrag = (
    fromY: number,
    toY: number,
    end: 'pointerup' | 'pointercancel' | 'lostpointercapture' = 'pointerup',
  ) => {
    overlay.dispatch('pointerdown', pointer(axisX, fromY));
    overlay.dispatch('pointermove', pointer(axisX, toY));
    overlay.dispatch(end, pointer(axisX, toY));
    env.flushFrames();
  };
  return { env, chart, data, overlay, frame, axisX, range, span, wheel, axisDrag };
}

describe('entering MANUAL mode', () => {
  test('starts in AUTO; a price-axis drag switches to MANUAL', () => {
    const t = setup();
    expect(t.chart.getPriceScaleMode()).toBe('auto');
    t.axisDrag(300, 250);
    expect(t.chart.getPriceScaleMode()).toBe('manual');
  });

  test('drag up stretches (smaller range), drag down compresses (larger range)', () => {
    const up = setup();
    const before = up.span();
    up.axisDrag(300, 200);
    expect(up.span()).toBeLessThan(before);
    const down = setup();
    down.axisDrag(300, 400);
    expect(down.span()).toBeGreaterThan(before);
  });

  test('drag is continuous and computed from the drag start (no accumulation)', () => {
    const t = setup();
    const start = t.range();
    t.overlay.dispatch('pointerdown', pointer(t.axisX, 300));
    for (let y = 300; y >= 200; y -= 7) t.overlay.dispatch('pointermove', pointer(t.axisX, y));
    t.overlay.dispatch('pointermove', pointer(t.axisX, 200));
    t.env.flushFrames();
    const viaSteps = t.span();
    const single = setup();
    single.axisDrag(300, 200);
    expect(viaSteps).toBeCloseTo(single.span(), 9);
    expect(start.max - start.min).toBeGreaterThan(viaSteps);
  });

  test('the price under the pointer at drag start keeps its height', () => {
    const t = setup();
    const anchor = t.frame().priceScale!.toPrice(300);
    t.axisDrag(300, 180);
    expect(t.frame().priceScale!.toY(anchor)).toBeCloseTo(300, 6);
  });

  test('wheel over the price axis scales prices, anchored at the pointer', () => {
    const t = setup();
    const before = t.span();
    const anchor = t.frame().priceScale!.toPrice(150);
    expect(t.wheel(t.axisX, 150, -200)).toBe(true); // prevented: no page scroll
    t.env.flushFrames();
    expect(t.chart.getPriceScaleMode()).toBe('manual');
    expect(t.span()).toBeLessThan(before);
    expect(t.frame().priceScale!.toY(anchor)).toBeCloseTo(150, 6);
  });
});

describe('separation of horizontal and vertical operations', () => {
  test('price-axis drag and wheel never change the horizontal view', () => {
    const t = setup();
    const view = t.chart.getView();
    t.axisDrag(300, 100);
    t.wheel(t.axisX, 300, 400);
    t.env.flushFrames();
    expect(t.chart.getView()).toEqual(view);
    expect(t.chart.isPanning()).toBe(false);
  });

  test('wheel over the plot zooms horizontally and does not touch the price-scale mode', () => {
    const t = setup();
    const spacing = t.chart.getView().barSpacing;
    t.wheel(400, 300, -300);
    t.env.flushFrames();
    expect(t.chart.getView().barSpacing).toBeGreaterThan(spacing);
    expect(t.chart.getPriceScaleMode()).toBe('auto');
  });
});

describe('MANUAL survives horizontal interaction and resize', () => {
  test('horizontal pan preserves the manual range', () => {
    const t = setup();
    t.axisDrag(300, 220);
    const manual = t.range();
    t.overlay.dispatch('pointerdown', pointer(200, 300));
    t.overlay.dispatch('pointermove', pointer(700, 300));
    t.overlay.dispatch('pointerup', pointer(700, 300));
    t.env.flushFrames();
    expect(t.chart.getView().rightOffset).not.toBe(6);
    expect(t.range()).toEqual(manual);
  });

  test('horizontal zoom preserves the manual range', () => {
    const t = setup();
    t.axisDrag(300, 380);
    const manual = t.range();
    t.wheel(500, 300, 250);
    t.env.flushFrames();
    expect(t.chart.getView().barSpacing).toBeLessThan(7);
    expect(t.range()).toEqual(manual);
  });

  test('resize keeps MANUAL and the same price range (new height, same prices)', () => {
    const t = setup();
    t.axisDrag(300, 250);
    const manual = t.range();
    t.env.resizeCallback!({ cssWidth: 700, cssHeight: 420 });
    t.env.flushFrames();
    expect(t.chart.getPriceScaleMode()).toBe('manual');
    expect(t.range()).toEqual(manual);
    expect(t.frame().layout.height).toBe(420);
  });
});

describe('back to AUTO', () => {
  test('double-click on the price axis restores auto-fit of the visible bars', () => {
    const t = setup();
    const auto = t.range();
    t.axisDrag(300, 150);
    expect(t.range()).not.toEqual(auto);
    t.overlay.dispatch('dblclick', { offsetX: t.axisX, offsetY: 300 });
    t.env.flushFrames();
    expect(t.chart.getPriceScaleMode()).toBe('auto');
    expect(t.range()).toEqual(auto);
    // Auto again follows pan.
    t.overlay.dispatch('pointerdown', pointer(100, 300));
    t.overlay.dispatch('pointermove', pointer(900, 300));
    t.env.flushFrames();
    expect(t.range()).not.toEqual(auto);
  });

  test('double-click on the plot does not reset the price scale', () => {
    const t = setup();
    t.axisDrag(300, 150);
    t.overlay.dispatch('dblclick', { offsetX: 300, offsetY: 300 });
    expect(t.chart.getPriceScaleMode()).toBe('manual');
  });

  test('resetPriceScale() API restores AUTO', () => {
    const t = setup();
    t.axisDrag(300, 150);
    t.chart.resetPriceScale();
    expect(t.chart.getPriceScaleMode()).toBe('auto');
  });

  test('setData (symbol or timeframe switch) resets to AUTO', () => {
    for (const count of [300, 780]) {
      const t = setup();
      t.axisDrag(300, 120);
      expect(t.chart.getPriceScaleMode()).toBe('manual');
      const other = demoSeries({ count });
      t.chart.setData({
        bars: other.bars,
        timeScale: other.mapping,
        formatPrice: other.formatPrice,
        formatTime: other.formatTime,
        minPriceStep: 0.01,
      });
      t.env.flushFrames();
      expect(t.chart.getPriceScaleMode()).toBe('auto');
    }
  });
});

describe('crosshair after manual scaling', () => {
  test('pointer y -> price uses the active (manual) scale; line and label agree', () => {
    const t = setup();
    t.axisDrag(300, 170);
    t.overlay.dispatch('pointermove', pointer(400, 222));
    t.env.flushFrames();
    const c = t.chart.getCrosshair()!;
    const scale = t.frame().priceScale!;
    expect(c.price).toBeCloseTo(scale.toPrice(222), 12);
    expect(scale.toY(c.price!)).toBeCloseTo(222, 9);
    expect(c.priceText).toBe(t.data.formatPrice(c.price!));
    const label = t.overlay.ctx.texts.find((x) => x.text === c.priceText);
    expect(label).toBeDefined();
  });
});

describe('robustness', () => {
  test('pointercancel / lost capture end a price drag (never stuck)', () => {
    for (const end of ['pointercancel', 'lostpointercapture'] as const) {
      const t = setup();
      t.axisDrag(300, 250, end);
      expect(t.chart.isScalingPrice()).toBe(false);
      const r = t.range();
      t.overlay.dispatch('pointermove', pointer(t.axisX, 50));
      t.env.flushFrames();
      expect(t.range()).toEqual(r);
      expect(t.overlay.captured.size).toBe(0);
    }
  });

  test('a storm of price-axis wheel events stays finite and within limits', () => {
    const t = setup();
    for (let i = 0; i < 300; i++) t.wheel(t.axisX, 100 + (i % 300), i % 3 ? 900 : -900);
    for (let i = 0; i < 300; i++) t.wheel(t.axisX, 20, 5000);
    t.env.flushFrames();
    const r = t.range();
    expect(Number.isFinite(r.min) && Number.isFinite(r.max)).toBe(true);
    expect(r.max).toBeGreaterThan(r.min);
    for (let i = 0; i < 300; i++) t.wheel(t.axisX, 300, -5000);
    t.env.flushFrames();
    expect(t.span()).toBeGreaterThan(0);
    expect(t.frame().priceTicks.every((tick) => Number.isFinite(tick.y))).toBe(true);
  });

  test('the price-axis drag uses the primary button only', () => {
    const t = setup();
    t.overlay.dispatch('pointerdown', pointer(t.axisX, 300, { button: 2 }));
    expect(t.chart.isScalingPrice()).toBe(false);
  });
});
