import { describe, expect, test } from 'vitest';
import { FumeChart } from '../src/chart.ts';
import { DEFAULT_THEME } from '../src/theme.ts';
import { demoSeries, FakeEnvironment, fakeContainer } from './fakes.ts';

function setup(dpr = 1) {
  const env = new FakeEnvironment();
  env.dpr = dpr;
  const container = fakeContainer();
  const data = demoSeries();
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
  const canvas = env.canvases[0]!;
  const overlay = env.canvases[1]!;
  return { env, container, data, chart, canvas, overlay };
}

describe('FumeChart lifecycle', () => {
  test('creates the main, drawing and overlay canvases (bottom to top); observes size and DPR', () => {
    const { env, container, canvas, overlay } = setup();
    const drawingLayer = env.canvases[2]!;
    expect(container.children).toEqual([canvas, drawingLayer, overlay]);
    expect(env.canvases).toHaveLength(3);
    expect(env.activeObservers).toBe(1);
    expect(env.activeRatioWatchers).toBe(1);
    // Only the overlay receives input; the main and drawing canvases ignore pointer events.
    for (const layer of [canvas, drawingLayer]) {
      expect(layer.listenerCount()).toBe(0);
      expect(layer.style.pointerEvents).toBe('none');
    }
    expect([...overlay.listeners.keys()].sort()).toEqual(
      [
        'dblclick',
        'keydown',
        'lostpointercapture',
        'pointercancel',
        'pointerdown',
        'pointerleave',
        'pointermove',
        'pointerup',
        'wheel',
      ].sort(),
    );
    expect(overlay.style.touchAction).toBe('none');
  });

  test('backing store follows CSS size x DPR on resize', () => {
    const { env, canvas } = setup(2);
    env.resizeCallback!({ cssWidth: 800, cssHeight: 500 });
    expect([canvas.width, canvas.height]).toEqual([1600, 1000]);
    for (const layer of env.canvases.slice(1))
      expect([layer.width, layer.height]).toEqual([1600, 1000]);
    env.dpr = 3;
    env.pixelRatioCallback!();
    expect([canvas.width, canvas.height]).toEqual([2400, 1500]);
    env.resizeCallback!({ cssWidth: 801, cssHeight: 500, device: { width: 1603, height: 1000 } });
    expect(canvas.width).toBe(1603);
  });

  test('many changes coalesce into one animation frame', () => {
    const { env, chart, data } = setup();
    env.resizeCallback!({ cssWidth: 800, cssHeight: 500 });
    chart.setBars(data.bars);
    chart.setOptions({ barSpacing: 9 });
    expect(env.frames.size).toBe(1);
    expect(env.flushFrames()).toBe(1);
    expect(chart.getLastFrame()?.candles.count).toBeGreaterThan(50);
  });

  test('renders candles with up/down colors, price labels, time labels, last price', () => {
    const { env, chart, data, canvas } = setup(2);
    env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
    chart.setBars(data.bars);
    env.flushFrames();
    const { rects, texts } = canvas.ctx;
    expect(rects.some((r) => r.style === DEFAULT_THEME.upColor)).toBe(true);
    expect(rects.some((r) => r.style === DEFAULT_THEME.downColor)).toBe(true);
    expect(
      texts.some((t) => /^\d+\.\d\d$/.test(t.text) && t.style === DEFAULT_THEME.axisText),
    ).toBe(true);
    expect(texts.some((t) => /^\d\d:\d\d$/.test(t.text))).toBe(true);
    const last = data.bars[data.bars.length - 1]!;
    expect(
      texts.some(
        (t) => t.text === data.formatPrice(last.close) && t.style === DEFAULT_THEME.lastPriceText,
      ),
    ).toBe(true);
    // Everything is drawn on whole device pixels.
    expect(rects.every((r) => [r.x, r.y, r.w, r.h].every(Number.isInteger))).toBe(true);
  });

  test('zero size renders nothing', () => {
    const { env, chart, data, canvas } = setup();
    chart.setBars(data.bars);
    env.resizeCallback!({ cssWidth: 0, cssHeight: 0 });
    env.flushFrames();
    expect(canvas.ctx.rects).toHaveLength(0);
  });

  test('destroy removes the canvas, disconnects observers, cancels frames; later calls are no-ops', () => {
    const { env, chart, data, canvas } = setup();
    env.resizeCallback!({ cssWidth: 800, cssHeight: 500 });
    chart.setBars(data.bars);
    expect(env.frames.size).toBe(1);
    chart.destroy();
    expect(env.canvases.every((c) => c.removed && c.listenerCount() === 0)).toBe(true);
    expect(env.activeObservers).toBe(0);
    expect(env.activeRatioWatchers).toBe(0);
    expect(env.frames.size).toBe(0);
    chart.setBars(data.bars);
    chart.render();
    chart.destroy();
    expect(env.frames.size).toBe(0);
    expect(canvas.ctx.rects).toHaveLength(0);
  });

  test('two charts do not share state', () => {
    const a = setup();
    const b = setup();
    a.env.resizeCallback!({ cssWidth: 800, cssHeight: 500 });
    b.env.resizeCallback!({ cssWidth: 400, cssHeight: 300 });
    a.chart.setBars(a.data.bars);
    b.chart.setBars(a.data.bars.slice(0, 100));
    a.env.flushFrames();
    b.env.flushFrames();
    expect(a.chart.getLastFrame()!.layout.width).toBe(800);
    expect(b.chart.getLastFrame()!.layout.width).toBe(400);
    expect(b.chart.getLastFrame()!.visible.to).toBe(100);
  });
});
