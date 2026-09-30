/**
 * MANUAL-mode 2D plot panning, the explicit live-follow state and goToLatest(), through the real
 * chart listeners with a fake browser environment.
 */
import { describe, expect, test } from 'vitest';
import type { Bar } from '@fume/core';
import { FumeChart, type FollowingLatestState } from '../src/chart.ts';
import { demoSeries, FakeEnvironment, fakeContainer, pointer } from './fakes.ts';

const base = demoSeries().bars; // 780 5m bars, SPY-like prices

function setup(bars: readonly Bar[] = base, minPriceStep = 0.01) {
  const env = new FakeEnvironment();
  env.dpr = 2;
  const data = demoSeries();
  const reports: FollowingLatestState[] = [];
  const chart = new FumeChart(
    fakeContainer(),
    {
      timeScale: data.mapping,
      formatPrice: (p) => p.toFixed(4),
      formatTime: data.formatTime,
      minPriceStep,
      onFollowingLatestChange: (s) => reports.push(s),
    },
    env,
  );
  env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
  chart.setBars(bars);
  env.flushFrames();
  const overlay = env.canvases[1]!;
  const flush = () => env.flushFrames();
  const frame = () => chart.getLastFrame()!;
  const range = () => ({ ...frame().priceScale!.range });
  const span = () => range().max - range().min;
  const plotH = () => frame().layout.plot.height;
  const makeManual = () => {
    const x = frame().layout.priceAxis.x + 10;
    overlay.dispatch('pointerdown', pointer(x, 300));
    overlay.dispatch('pointermove', pointer(x, 240));
    overlay.dispatch('pointerup', pointer(x, 240));
    flush();
    expect(chart.getPriceScaleMode()).toBe('manual');
  };
  const drag = (
    dx: number,
    dy: number,
    end: 'pointerup' | 'pointercancel' | 'lostpointercapture' = 'pointerup',
  ) => {
    overlay.dispatch('pointerdown', pointer(500, 300));
    overlay.dispatch('pointermove', pointer(500 + dx, 300 + dy));
    overlay.dispatch(end, pointer(500 + dx, 300 + dy));
    flush();
  };
  return { env, chart, overlay, flush, frame, range, span, plotH, makeManual, drag, reports };
}

describe('MANUAL mode: 2D plot drag', () => {
  test('horizontal-only drag pans time and leaves the price range untouched', () => {
    const t = setup();
    t.makeManual();
    const r = t.range();
    const offset = t.chart.getView().rightOffset;
    t.drag(200, 0);
    expect(t.chart.getView().rightOffset).not.toBe(offset);
    expect(t.range()).toEqual(r);
  });

  test('vertical-only drag translates the range, preserves the span, keeps time', () => {
    const t = setup();
    t.makeManual();
    const r = t.range();
    const view = t.chart.getView();
    t.drag(0, 90);
    const moved = t.range();
    expect(t.chart.getView()).toEqual(view);
    expect(moved.max - moved.min).toBeCloseTo(r.max - r.min, 9);
    expect(moved.min).toBeCloseTo(r.min + (90 * (r.max - r.min)) / t.plotH(), 9);
  });

  test('drag down moves candles down; drag up moves them up (intuitive direction)', () => {
    const t = setup();
    t.makeManual();
    const price = (t.range().min + t.range().max) / 2;
    const y0 = t.frame().priceScale!.toY(price);
    t.drag(0, 50);
    expect(t.frame().priceScale!.toY(price)).toBeCloseTo(y0 + 50, 6);
    t.drag(0, -120);
    expect(t.frame().priceScale!.toY(price)).toBeCloseTo(y0 - 70, 6);
  });

  test('diagonal drag changes time and price together', () => {
    const t = setup();
    t.makeManual();
    const r = t.range();
    const offset = t.chart.getView().rightOffset;
    t.drag(140, -60);
    expect(t.chart.getView().rightOffset).toBeCloseTo(
      offset - 140 / t.chart.getView().barSpacing,
      9,
    );
    expect(t.range().min).toBeCloseTo(r.min - (60 * (r.max - r.min)) / t.plotH(), 9);
  });

  test('uses the drag-start range: many small moves equal one move (no compounding)', () => {
    const a = setup();
    a.makeManual();
    a.overlay.dispatch('pointerdown', pointer(500, 300));
    for (let y = 300; y <= 480; y += 3) a.overlay.dispatch('pointermove', pointer(500, y));
    a.overlay.dispatch('pointermove', pointer(500, 481));
    a.overlay.dispatch('pointerup', pointer(500, 481));
    a.flush();
    const b = setup();
    b.makeManual();
    b.drag(0, 181);
    expect(a.range()).toEqual(b.range());
  });

  test('repeated drags stay finite with an unchanged span', () => {
    const t = setup();
    t.makeManual();
    const s = t.span();
    for (let i = 0; i < 200; i++) t.drag(i % 2 ? 37 : -41, i % 3 ? 5000 : -4000);
    const r = t.range();
    expect(Number.isFinite(r.min) && Number.isFinite(r.max)).toBe(true);
    expect(t.span()).toBeCloseTo(s, 6);
  });

  test('negative-price data', () => {
    const neg = base.map((b) => ({
      ...b,
      open: b.open - 700,
      high: b.high - 700,
      low: b.low - 700,
      close: b.close - 700,
    }));
    const t = setup(neg);
    t.makeManual();
    const s = t.span();
    t.drag(-30, 70);
    expect(t.range().max).toBeLessThan(0);
    expect(t.span()).toBeCloseTo(s, 9);
  });

  test('sub-penny data', () => {
    const k = 1e-5;
    const sub = base.map((b) => ({
      ...b,
      open: b.open * k,
      high: b.high * k,
      low: b.low * k,
      close: b.close * k,
    }));
    const t = setup(sub, 0.0000001);
    t.makeManual();
    const s = t.span();
    t.drag(10, -45);
    expect(t.span()).toBeCloseTo(s, 12);
    expect(Math.abs(t.range().min - 0.0058) < 0.01).toBe(true);
  });

  test('pointercancel and lost capture end BOTH axes of the drag', () => {
    for (const end of ['pointercancel', 'lostpointercapture'] as const) {
      const t = setup();
      t.makeManual();
      t.drag(80, 80, end);
      expect(t.chart.isPanning()).toBe(false);
      const view = t.chart.getView();
      const r = t.range();
      t.overlay.dispatch('pointermove', pointer(900, 100));
      t.flush();
      expect(t.chart.getView()).toEqual(view);
      expect(t.range()).toEqual(r);
      expect(t.overlay.captured.size).toBe(0);
    }
  });

  test('crosshair price uses the translated range', () => {
    const t = setup();
    t.makeManual();
    t.drag(0, 75);
    t.overlay.dispatch('pointermove', pointer(400, 210));
    t.flush();
    const c = t.chart.getCrosshair()!;
    const scale = t.frame().priceScale!;
    expect(c.price).toBeCloseTo(scale.toPrice(210), 12);
    expect(scale.toY(c.price!)).toBeCloseTo(210, 9);
    expect(t.overlay.ctx.texts.some((x) => x.text === c.priceText)).toBe(true);
  });
});

describe('AUTO mode: plot drag stays horizontal', () => {
  test('vertical movement does not move the price range; horizontal pan still works; AUTO keeps fitting', () => {
    const t = setup();
    const r = t.range();
    t.drag(0, 150);
    expect(t.chart.getPriceScaleMode()).toBe('auto');
    expect(t.range()).toEqual(r);
    t.drag(300, 150);
    expect(t.chart.getPriceScaleMode()).toBe('auto');
    const { from, to } = t.frame().visible;
    const lows = Math.min(...base.slice(from, to).map((b) => b.low));
    const highs = Math.max(...base.slice(from, to).map((b) => b.high));
    expect(t.range().min).toBeLessThan(lows);
    expect(t.range().max).toBeGreaterThan(highs);
  });
});

describe('live updates never move a placed view', () => {
  test('a live trade (active candle upsert) does not change the translated manual range', () => {
    const t = setup(base.slice(0, 700));
    t.makeManual();
    t.drag(0, 120);
    const r = t.range();
    const last = base[699]!;
    t.chart.upsertBars([{ ...last, high: last.high + 40, close: last.close + 1 }]);
    t.flush();
    expect(t.range()).toEqual(r);
  });

  test('a new candle while panned away does not yank the view horizontally', () => {
    const t = setup(base.slice(0, 700));
    t.drag(800, 0);
    expect(t.chart.isFollowingLatest()).toBe(false);
    const f = t.frame();
    const x = f.viewport.slotToX(600);
    t.chart.upsertBars([base[700]!]);
    t.flush();
    expect(t.frame().viewport.slotToX(600)).toBeCloseTo(x, 9);
    expect(t.chart.isFollowingLatest()).toBe(false);
  });
});

describe('isFollowingLatest / goToLatest', () => {
  test('following after load; reported to the host with the plot corner', () => {
    const t = setup();
    expect(t.chart.isFollowingLatest()).toBe(true);
    expect(t.reports.at(-1)!.following).toBe(true);
    const f = t.frame().layout;
    expect(t.reports.at(-1)!.plotCorner).toEqual({
      right: f.width - f.plot.width,
      bottom: f.height - f.plot.height,
    });
    expect(t.chart.goToLatest()).toBe(false); // nothing to do
  });

  test('panning away turns following off (reported once, not per frame)', () => {
    const t = setup();
    const before = t.reports.length;
    t.drag(600, 0);
    t.drag(100, 0);
    expect(t.chart.isFollowingLatest()).toBe(false);
    expect(t.reports.slice(before).map((r) => r.following)).toEqual([false]);
  });

  test('goToLatest restores the live edge, keeps bar spacing and the MANUAL range; new bars follow again', () => {
    const t = setup(base.slice(0, 700));
    t.overlay.dispatch('wheel', {
      offsetX: 400,
      offsetY: 300,
      deltaX: 0,
      deltaY: -200,
      deltaMode: 0,
      ctrlKey: false,
    });
    t.flush();
    t.makeManual();
    t.drag(900, 60);
    expect(t.chart.isFollowingLatest()).toBe(false);
    const spacing = t.chart.getView().barSpacing;
    const r = t.range();
    const x600 = t.frame().viewport.slotToX(600);
    t.chart.upsertBars([base[700]!]); // live bar while away: view stays
    t.flush();
    expect(t.frame().viewport.slotToX(600)).toBeCloseTo(x600, 9);

    expect(t.chart.goToLatest()).toBe(true);
    t.flush();
    expect(t.chart.isFollowingLatest()).toBe(true);
    expect(t.reports.at(-1)!.following).toBe(true);
    expect(t.chart.getView()).toEqual({ barSpacing: spacing, rightOffset: 6 });
    expect(t.chart.getPriceScaleMode()).toBe('manual');
    expect(t.range()).toEqual(r);

    const lastX = t.frame().viewport.slotToX(700);
    t.chart.upsertBars([base[701]!]); // following again: the view advances with the new bar
    t.flush();
    expect(t.frame().viewport.slotToX(701)).toBeCloseTo(lastX, 9);
  });

  test('setData resets into the normal latest-following state', () => {
    const t = setup();
    t.drag(700, 0);
    expect(t.chart.isFollowingLatest()).toBe(false);
    t.chart.setBars(base);
    t.flush();
    expect(t.chart.isFollowingLatest()).toBe(true);
    expect(t.reports.at(-1)!.following).toBe(true);
  });
});

describe('older-history prepend with a translated MANUAL window', () => {
  test('prepend keeps the translated range, the horizontal view and the following state', () => {
    const t = setup(base.slice(390));
    t.makeManual();
    t.drag(500, -80);
    const r = t.range();
    const vis = t.frame().viewport.visibleSlots();
    const following = t.chart.isFollowingLatest();
    t.chart.prependBars(base.slice(0, 390));
    t.flush();
    expect(t.range()).toEqual(r);
    expect(t.frame().viewport.visibleSlots()).toEqual(vis);
    expect(t.chart.isFollowingLatest()).toBe(following);
  });

  test('prepend while following does not turn following off', () => {
    const t = setup(base.slice(390));
    expect(t.chart.isFollowingLatest()).toBe(true);
    t.chart.prependBars(base.slice(0, 390));
    t.flush();
    expect(t.chart.isFollowingLatest()).toBe(true);
  });
});
