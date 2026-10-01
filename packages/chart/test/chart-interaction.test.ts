/**
 * FumeChart driven through its real event listeners with a fake browser environment.
 */
import { describe, expect, test } from 'vitest';
import { FumeChart } from '../src/chart.ts';
import { DEFAULT_VIEW_LIMITS } from '../src/view-state.ts';
import { demoSeries, FakeEnvironment, fakeContainer, pointer } from './fakes.ts';

function setup(options: { bars?: number } = {}) {
  const env = new FakeEnvironment();
  env.dpr = 2;
  const container = fakeContainer();
  const data = demoSeries({ dropIndices: [756], ...(options.bars ? { count: options.bars } : {}) });
  const chart = new FumeChart(
    container,
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
  const main = env.canvases[0]!;
  const overlay = env.canvases[1]!;
  return { env, chart, data, main, overlay };
}

describe('crosshair (overlay layer)', () => {
  test('pointer move repaints only the overlay; candles are not rebuilt', () => {
    const { env, chart, main, overlay } = setup();
    const frameBefore = chart.getLastFrame();
    main.ctx.reset();
    overlay.ctx.reset();
    overlay.dispatch('pointermove', pointer(500, 200));
    env.flushFrames();
    expect(main.ctx.rects).toHaveLength(0);
    expect(overlay.ctx.clears).toBe(1);
    expect(chart.getLastFrame()).toBe(frameBefore); // same frame object: no rebuild
    const c = chart.getCrosshair()!;
    expect(c.slot).toBe(Math.round(frameBefore!.viewport.xToSlot(500)));
    expect(c.price).toBeCloseTo(frameBefore!.priceScale!.toPrice(200), 12);
    // Price and time readouts are drawn on the overlay.
    expect(overlay.ctx.texts.some((t) => t.text === c.priceText)).toBe(true);
    expect(overlay.ctx.texts.some((t) => t.text === c.timeText)).toBe(true);
  });

  test('OHLC legend shows the hovered bar, or the latest bar without a crosshair', () => {
    const { env, chart, data, overlay } = setup();
    const last = data.bars[data.bars.length - 1]!;
    expect(overlay.ctx.texts.some((t) => t.text === data.formatPrice(last.close))).toBe(true);
    overlay.ctx.reset();
    const frame = chart.getLastFrame()!;
    overlay.dispatch('pointermove', pointer(frame.viewport.slotToX(700), 150));
    env.flushFrames();
    const hovered = chart.getCrosshair()!.bar!;
    for (const v of [hovered.open, hovered.high, hovered.low, hovered.close]) {
      expect(overlay.ctx.texts.some((t) => t.text === data.formatPrice(v))).toBe(true);
    }
  });

  test('hidden when the pointer leaves the plot or the chart', () => {
    const { env, chart, overlay } = setup();
    overlay.dispatch('pointermove', pointer(500, 200));
    env.flushFrames();
    expect(chart.getCrosshair()).not.toBeNull();
    const plot = chart.getLastFrame()!.layout.plot;
    overlay.dispatch('pointermove', pointer(plot.width + 10, 200)); // over the price axis
    env.flushFrames();
    expect(chart.getCrosshair()).toBeNull();
    overlay.dispatch('pointermove', pointer(500, 200));
    overlay.dispatch('pointerleave', pointer(-5, 200));
    env.flushFrames();
    expect(chart.getCrosshair()).toBeNull();
  });

  test('over a gap slot the crosshair has no bar', () => {
    const { env, chart, overlay } = setup();
    const x = chart.getLastFrame()!.viewport.slotToX(756);
    overlay.dispatch('pointermove', pointer(x, 200));
    env.flushFrames();
    expect(chart.getCrosshair()!.slot).toBe(756);
    expect(chart.getCrosshair()!.bar).toBeNull();
  });
});

describe('pan (pointer drag)', () => {
  test('drag right by N px moves back N/spacing slots; content follows the cursor', () => {
    const { env, chart, overlay } = setup();
    const before = chart.getView();
    const slotUnder = chart.getLastFrame()!.viewport.xToSlot(300);
    expect(overlay.dispatch('pointerdown', pointer(300, 200))).toBe(true); // preventDefault: no text selection
    expect(overlay.captured.has(1)).toBe(true);
    expect(chart.isPanning()).toBe(true);
    overlay.dispatch('pointermove', pointer(440, 260));
    env.flushFrames();
    expect(chart.getView().rightOffset).toBeCloseTo(
      before.rightOffset - 140 / before.barSpacing,
      9,
    );
    expect(chart.getLastFrame()!.viewport.slotToX(slotUnder)).toBeCloseTo(440, 6);
    overlay.dispatch('pointerup', pointer(440, 260));
    expect(chart.isPanning()).toBe(false);
    expect(overlay.captured.has(1)).toBe(false);
  });

  test('price scale is recomputed from the newly visible bars', () => {
    const { env, chart, overlay } = setup();
    const rangeBefore = chart.getLastFrame()!.priceScale!.range;
    overlay.dispatch('pointerdown', pointer(100, 200));
    overlay.dispatch('pointermove', pointer(900, 200));
    env.flushFrames();
    const frame = chart.getLastFrame()!;
    const { from, to } = frame.visible;
    const series = demoSeries({ dropIndices: [756] }).bars;
    const lows = Math.min(...series.slice(from, to).map((b) => b.low));
    expect(frame.priceScale!.range).not.toEqual(rangeBefore);
    expect(frame.priceScale!.range.min).toBeLessThan(lows);
  });

  test('bounded: dragging far in either direction stops with bars visible', () => {
    const { env, chart, overlay } = setup();
    overlay.dispatch('pointerdown', pointer(100, 200));
    overlay.dispatch('pointermove', pointer(1e7, 200));
    env.flushFrames();
    expect(chart.getLastFrame()!.candles.count).toBeGreaterThanOrEqual(
      DEFAULT_VIEW_LIMITS.minVisibleBars,
    );
    overlay.dispatch('pointermove', pointer(-1e7, 200));
    env.flushFrames();
    expect(chart.getLastFrame()!.candles.count).toBeGreaterThanOrEqual(
      DEFAULT_VIEW_LIMITS.minVisibleBars,
    );
    expect(Number.isFinite(chart.getView().rightOffset)).toBe(true);
  });

  test('pointercancel and lost capture end the drag (never stuck)', () => {
    for (const end of ['pointercancel', 'lostpointercapture'] as const) {
      const { env, chart, overlay } = setup();
      overlay.dispatch('pointerdown', pointer(300, 200));
      overlay.dispatch(end, pointer(300, 200));
      expect(chart.isPanning()).toBe(false);
      const view = chart.getView();
      overlay.dispatch('pointermove', pointer(600, 200));
      env.flushFrames();
      expect(chart.getView()).toEqual(view); // moves no longer pan
    }
  });

  test('pointer leaving during a captured drag keeps panning until release', () => {
    const { env, chart, overlay } = setup();
    overlay.dispatch('pointerdown', pointer(300, 200));
    overlay.dispatch('pointerleave', pointer(-10, 200));
    expect(chart.isPanning()).toBe(true);
    overlay.dispatch('pointermove', pointer(350, 200));
    overlay.dispatch('pointerup', pointer(350, 200));
    env.flushFrames();
    expect(chart.isPanning()).toBe(false);
  });

  test('non-primary buttons and presses outside the plot do not pan', () => {
    const { chart, overlay } = setup();
    overlay.dispatch('pointerdown', pointer(300, 200, { button: 2 }));
    expect(chart.isPanning()).toBe(false);
    const plot = chart.getLastFrame()!.layout.plot;
    overlay.dispatch('pointerdown', pointer(plot.width + 5, 200));
    expect(chart.isPanning()).toBe(false);
  });
});

describe('zoom (wheel)', () => {
  test('wheel over the plot zooms around the pointer and prevents page scroll', () => {
    const { env, chart, overlay } = setup();
    const frame = chart.getLastFrame()!;
    const slotUnder = frame.viewport.xToSlot(400);
    const prevented = overlay.dispatch('wheel', {
      offsetX: 400,
      offsetY: 200,
      deltaX: 0,
      deltaY: -200,
      deltaMode: 0,
      ctrlKey: false,
    });
    expect(prevented).toBe(true);
    env.flushFrames();
    expect(chart.getView().barSpacing).toBeGreaterThan(frame.viewport.barSpacing);
    expect(chart.getLastFrame()!.viewport.xToSlot(400)).toBeCloseTo(slotUnder, 6);
  });

  test('wheel over the price axis never zooms horizontally (it scales prices instead)', () => {
    const { chart, overlay } = setup();
    const plot = chart.getLastFrame()!.layout.plot;
    const view = chart.getView();
    overlay.dispatch('wheel', {
      offsetX: plot.width + 10,
      offsetY: 200,
      deltaX: 0,
      deltaY: -200,
      deltaMode: 0,
      ctrlKey: false,
    });
    expect(chart.getView()).toEqual(view);
    expect(chart.getPriceScaleMode()).toBe('manual');
  });

  test('spacing stays within limits under a storm of wheel events', () => {
    const { env, chart, overlay } = setup();
    for (let i = 0; i < 100; i++)
      overlay.dispatch('wheel', {
        offsetX: 400,
        offsetY: 200,
        deltaX: 0,
        deltaY: -500,
        deltaMode: 0,
        ctrlKey: false,
      });
    env.flushFrames();
    expect(chart.getView().barSpacing).toBe(DEFAULT_VIEW_LIMITS.maxBarSpacing);
    for (let i = 0; i < 100; i++)
      overlay.dispatch('wheel', {
        offsetX: 400,
        offsetY: 200,
        deltaX: 0,
        deltaY: 500,
        deltaMode: 0,
        ctrlKey: false,
      });
    env.flushFrames();
    expect(chart.getView().barSpacing).toBe(DEFAULT_VIEW_LIMITS.minBarSpacing);
    const frame = chart.getLastFrame()!;
    expect(frame.priceScale).not.toBeNull();
    expect(Number.isFinite(frame.priceScale!.range.min)).toBe(true);
  });

  test('resize after zoom keeps the zoom and re-clamps the view', () => {
    const { env, chart, overlay } = setup();
    overlay.dispatch('wheel', {
      offsetX: 400,
      offsetY: 200,
      deltaX: 0,
      deltaY: -300,
      deltaMode: 0,
      ctrlKey: false,
    });
    env.flushFrames();
    const spacing = chart.getView().barSpacing;
    env.resizeCallback!({ cssWidth: 600, cssHeight: 400 });
    env.flushFrames();
    expect(chart.getView().barSpacing).toBe(spacing);
    expect(chart.getLastFrame()!.layout.width).toBe(600);
    expect([overlay.width, overlay.height]).toEqual([1200, 800]);
  });
});

describe('setData (symbol / timeframe switch)', () => {
  test('replaces data atomically, resets the view to the latest bars and clears the crosshair', () => {
    const { env, chart, overlay } = setup();
    overlay.dispatch('pointerdown', pointer(300, 200));
    overlay.dispatch('pointermove', pointer(800, 200));
    overlay.dispatch('wheel', {
      offsetX: 400,
      offsetY: 200,
      deltaX: 0,
      deltaY: 300,
      deltaMode: 0,
      ctrlKey: false,
    });
    env.flushFrames();
    expect(chart.getCrosshair()).not.toBeNull();

    const other = demoSeries({ count: 200 });
    chart.setData({
      bars: other.bars,
      timeScale: other.mapping,
      formatPrice: other.formatPrice,
      formatTime: other.formatTime,
      minPriceStep: 0.01,
      barSpacing: 12,
      rightOffset: 3,
    });
    env.flushFrames();
    expect(chart.isPanning()).toBe(false);
    expect(chart.getCrosshair()).toBeNull();
    expect(chart.getView()).toEqual({ barSpacing: 12, rightOffset: 3 });
    const frame = chart.getLastFrame()!;
    expect(frame.visible.to).toBe(200); // the latest of the NEW bars
    expect(frame.viewport.anchorSlot).toBe(199);
    // Moving the pointer after the switch does not pan with the old drag.
    overlay.dispatch('pointermove', pointer(100, 200));
    env.flushFrames();
    expect(chart.getView()).toEqual({ barSpacing: 12, rightOffset: 3 });
  });

  test('empty data renders without NaN and ignores interaction safely', () => {
    const { env, chart, data, overlay } = setup();
    chart.setData({
      bars: [],
      timeScale: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: 0.01,
    });
    env.flushFrames();
    expect(chart.getLastFrame()!.priceScale).toBeNull();
    overlay.dispatch('pointermove', pointer(300, 200));
    overlay.dispatch('wheel', {
      offsetX: 300,
      offsetY: 200,
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      ctrlKey: false,
    });
    env.flushFrames();
    expect(chart.getCrosshair()!.price).toBeNull();
    expect(Number.isFinite(chart.getView().barSpacing)).toBe(true);
  });
});

describe('lifecycle', () => {
  test('destroy removes both canvases and every listener (8), and cancels a drag', () => {
    const { env, chart, main, overlay } = setup();
    overlay.dispatch('pointerdown', pointer(300, 200));
    chart.destroy();
    expect(main.removed && overlay.removed).toBe(true);
    expect(overlay.listenerCount()).toBe(0);
    expect(env.activeObservers + env.activeRatioWatchers).toBe(0);
    expect(chart.isPanning()).toBe(false);
  });

  test('StrictMode-style mount -> destroy -> mount leaves exactly one live set of listeners', () => {
    const env = new FakeEnvironment();
    const container = fakeContainer();
    const data = demoSeries();
    const opts = {
      timeScale: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: 0.01,
    };
    const first = new FumeChart(container, opts, env);
    first.destroy();
    const second = new FumeChart(container, opts, env);
    const live = env.canvases.filter((c) => !c.removed);
    expect(live).toHaveLength(3); // main, overlay, drawing layer of the second chart
    expect(env.canvases.slice(0, 3).every((c) => c.listenerCount() === 0)).toBe(true);
    expect(live[1]!.listenerCount()).toBe(9); // the overlay: pointer, wheel, dblclick, keydown
    expect(env.activeObservers).toBe(1);
    second.destroy();
  });
});
