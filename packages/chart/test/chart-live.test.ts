/**
 * Incremental (live) updates, history prepend and the older-data signal, driven through the real
 * chart with a fake browser environment. Stage 2 interaction state must survive all of them.
 */
import { describe, expect, test } from 'vitest';
import {
  createSessionTimeScale,
  resolveWeeklySessions,
  type Bar,
  type InstrumentId,
  type SessionWindow,
} from '@fume/core';
import { FumeChart, type OlderDataRequest } from '../src/chart.ts';
import { demoSeries, FakeEnvironment, fakeContainer, MIN, pointer } from './fakes.ts';

const all = demoSeries().bars; // 780 5m bars, Mar 2 .. Mar 13 (78 per session)

function setup(initial: readonly Bar[] = all, onNeedsOlderData?: (r: OlderDataRequest) => void) {
  const env = new FakeEnvironment();
  env.dpr = 2;
  const data = demoSeries();
  const chart = new FumeChart(
    fakeContainer(),
    {
      timeScale: data.mapping,
      formatPrice: data.formatPrice,
      formatTime: data.formatTime,
      minPriceStep: 0.01,
      ...(onNeedsOlderData ? { onNeedsOlderData } : {}),
    },
    env,
  );
  env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
  chart.setBars(initial);
  env.flushFrames();
  const overlay = env.canvases[1]!;
  const frame = () => chart.getLastFrame()!;
  const flush = () => env.flushFrames();
  const pan = (dx: number) => {
    overlay.dispatch('pointerdown', pointer(500, 300));
    overlay.dispatch('pointermove', pointer(500 + dx, 300));
    overlay.dispatch('pointerup', pointer(500 + dx, 300));
    flush();
  };
  const zoom = (deltaY: number) => {
    overlay.dispatch('wheel', {
      offsetX: 400,
      offsetY: 300,
      deltaX: 0,
      deltaY,
      deltaMode: 0,
      ctrlKey: false,
    });
    flush();
  };
  const axisDrag = (dy: number) => {
    const x = frame().layout.priceAxis.x + 10;
    overlay.dispatch('pointerdown', pointer(x, 300));
    overlay.dispatch('pointermove', pointer(x, 300 + dy));
    overlay.dispatch('pointerup', pointer(x, 300 + dy));
    flush();
  };
  return { env, chart, data, overlay, frame, flush, pan, zoom, axisDrag };
}

const next = (bar: Bar, dt = 5 * MIN, close = bar.close + 0.5): Bar => ({
  ...bar,
  start: bar.start + dt,
  open: bar.close,
  high: Math.max(bar.close, close) + 0.1,
  low: Math.min(bar.close, close) - 0.1,
  close,
});

describe('upsertBars (live updates)', () => {
  const partial = all.slice(0, 700); // leave room to append real next bars

  test('replacing the active candle keeps zoom, pan and the view untouched', () => {
    const t = setup(partial);
    t.zoom(-150);
    const view = t.chart.getView();
    const last = partial[partial.length - 1]!;
    const r = t.chart.upsertBars([{ ...last, close: last.close + 1, high: last.high + 1 }]);
    t.flush();
    expect(r).toMatchObject({ replaced: 1, appended: 0 });
    expect(t.chart.getView()).toEqual(view);
    expect(t.chart.getBarCount()).toBe(700);
    expect(t.frame().lastPrice!.price).toBe(last.close + 1);
  });

  test('append at the live edge: the new candle becomes visible (view follows)', () => {
    const t = setup(partial);
    const view = t.chart.getView();
    const lastX = t.frame().viewport.slotToX(699);
    const r = t.chart.upsertBars([all[700]!]);
    t.flush();
    expect(r.appended).toBe(1);
    expect(t.chart.getView()).toEqual(view); // same right offset: content scrolled by one slot
    expect(t.frame().viewport.anchorSlot).toBe(700);
    expect(t.frame().viewport.slotToX(700)).toBeCloseTo(lastX, 9);
    expect(t.frame().visible.to).toBe(701);
  });

  test('append while panned back into history: the view does NOT move', () => {
    const t = setup(partial);
    t.pan(600); // back into history; latest bar off-screen
    const f = t.frame();
    const refX = f.viewport.slotToX(500);
    const visible = f.viewport.visibleSlots();
    t.chart.upsertBars([all[700]!, all[701]!]);
    t.flush();
    expect(t.frame().viewport.slotToX(500)).toBeCloseTo(refX, 9);
    expect(t.frame().viewport.visibleSlots()).toEqual(visible);
  });

  test('append during an active drag does not make the drag jump', () => {
    const t = setup(partial);
    t.overlay.dispatch('pointerdown', pointer(500, 300));
    t.overlay.dispatch('pointermove', pointer(1100, 300));
    t.flush();
    const refX = t.frame().viewport.slotToX(500);
    t.chart.upsertBars([all[700]!]);
    t.overlay.dispatch('pointermove', pointer(1100, 300)); // same pointer position
    t.flush();
    expect(t.frame().viewport.slotToX(500)).toBeCloseTo(refX, 9);
    t.overlay.dispatch('pointerup', pointer(1100, 300));
  });

  test('zoom is retained across upserts', () => {
    const t = setup(partial);
    t.zoom(300);
    const spacing = t.chart.getView().barSpacing;
    t.chart.upsertBars([all[700]!]);
    t.flush();
    expect(t.chart.getView().barSpacing).toBe(spacing);
  });

  test('MANUAL price scale is retained; AUTO refits to the new data', () => {
    const manual = setup(partial);
    manual.axisDrag(-80);
    const range = { ...manual.frame().priceScale!.range };
    const last = partial[partial.length - 1]!;
    manual.chart.upsertBars([{ ...last, high: last.high + 50 }]);
    manual.flush();
    expect(manual.chart.getPriceScaleMode()).toBe('manual');
    expect(manual.frame().priceScale!.range).toEqual(range);

    const auto = setup(partial);
    const before = auto.frame().priceScale!.range.max;
    auto.chart.upsertBars([{ ...last, high: last.high + 50 }]);
    auto.flush();
    expect(auto.frame().priceScale!.range.max).toBeGreaterThan(before + 40);
  });

  test('the crosshair keeps following the pointer and reports the updated candle', () => {
    const t = setup(partial);
    const x = t.frame().viewport.slotToX(699);
    t.overlay.dispatch('pointermove', pointer(x, 250));
    t.flush();
    const last = partial[partial.length - 1]!;
    t.chart.upsertBars([{ ...last, close: last.close + 0.37 }]);
    t.flush();
    const c = t.chart.getCrosshair()!;
    expect(c.slot).toBe(699);
    expect(c.bar!.close).toBe(last.close + 0.37);
    expect(c.price).toBeCloseTo(t.frame().priceScale!.toPrice(250), 12);
  });

  test('a batch can replace and append at once; duplicates in a batch resolve to the last', () => {
    const t = setup(partial);
    const last = partial[partial.length - 1]!;
    const a = { ...all[700]!, close: 1 };
    const b = { ...all[700]!, close: 2 };
    const r = t.chart.upsertBars([{ ...last, close: 9 }, a, b]);
    expect(r).toMatchObject({ replaced: 1, appended: 1 });
    t.flush();
    expect(t.frame().lastPrice!.price).toBe(2);
  });
});

describe('prependBars (older history without a jump)', () => {
  const recent = all.slice(390); // Mar 9 .. Mar 13

  function expectNoJump(t: ReturnType<typeof setup>, act: () => void) {
    const f = t.frame();
    const ref = recent[200]!;
    const refSlot = f.viewport.xToSlot(f.viewport.slotToX(390 + 200));
    const refX = f.viewport.slotToX(refSlot);
    const visible = f.viewport.visibleSlots();
    const spacing = t.chart.getView().barSpacing;
    act();
    t.flush();
    const g = t.frame();
    expect(g.viewport.slotToX(refSlot)).toBeCloseTo(refX, 9);
    expect(g.viewport.visibleSlots()).toEqual(visible);
    expect(t.chart.getView().barSpacing).toBe(spacing);
    expect(ref.start).toBe(all[590]!.start);
  }

  test('prepend 10 bars', () => {
    const t = setup(recent);
    expectNoJump(t, () => expect(t.chart.prependBars(all.slice(380, 390)).inserted).toBe(10));
    expect(t.chart.getBarCount()).toBe(400);
  });

  test('prepend an entire prior session', () => {
    const t = setup(recent);
    expectNoJump(t, () => t.chart.prependBars(all.slice(312, 390)));
  });

  test('prepend with gaps (missing bars stay empty slots)', () => {
    const t = setup(recent);
    const gappy = all.slice(0, 390).filter((_, i) => i % 7 !== 3);
    expectNoJump(t, () => t.chart.prependBars(gappy));
    expect(t.chart.getBarCount()).toBe(recent.length + gappy.length);
  });

  test('prepend while zoomed', () => {
    const t = setup(recent);
    t.zoom(-250);
    expectNoJump(t, () => t.chart.prependBars(all.slice(0, 390)));
  });

  test('prepend while panned back', () => {
    const t = setup(recent);
    t.pan(900);
    expectNoJump(t, () => t.chart.prependBars(all.slice(0, 390)));
  });

  test('prepend while MANUAL price scale is active keeps the manual range', () => {
    const t = setup(recent);
    t.axisDrag(60);
    const range = { ...t.frame().priceScale!.range };
    expectNoJump(t, () => t.chart.prependBars(all.slice(0, 390)));
    expect(t.chart.getPriceScaleMode()).toBe('manual');
    expect(t.frame().priceScale!.range).toEqual(range);
  });

  test('prepend with a wider time scale re-slots everything without moving the picture', () => {
    const weekdays = (start: string, end: string): SessionWindow[] =>
      ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));
    const spec = {
      timezone: 'America/New_York',
      regular: weekdays('09:30', '16:00'),
      extended: [],
      calendarId: 'T',
    };
    const id = 'eq:TEST' as InstrumentId;
    const later = createSessionTimeScale({
      sessions: resolveWeeklySessions({
        instrumentId: id,
        spec,
        from: '2026-03-09',
        to: '2026-03-20',
      }),
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: 5 * MIN },
    });
    const wider = demoSeries().mapping; // from 2026-03-02
    const t = setup(recent);
    t.chart.setOptions({ timeScale: later });
    t.chart.setBars(recent);
    t.flush();
    const f = t.frame();
    const x100 = f.viewport.slotToX(100); // slot 100 under the later mapping = recent[100]
    t.chart.prependBars(all.slice(0, 390), { timeScale: wider });
    t.flush();
    expect(t.frame().viewport.slotToX(490)).toBeCloseTo(x100, 9); // same bar, new slot number
    expect(t.frame().viewport.visibleSlots().from).toBe(f.viewport.visibleSlots().from + 390);
  });
});

describe('onNeedsOlderData', () => {
  test('fires once near the oldest bar, stays quiet while pending, re-arms after prepend', () => {
    const requests: OlderDataRequest[] = [];
    const recent = all.slice(390);
    const t = setup(recent, (r) => requests.push(r));
    expect(requests).toHaveLength(0); // latest view is far from the oldest bar
    t.pan(2000);
    expect(requests).toEqual([{ before: recent[0]!.start }]);
    expect(t.chart.getOlderDataState()).toBe('pending');
    for (let i = 0; i < 20; i++) t.pan(i % 2 ? 40 : -40); // pan storm while pending
    expect(requests).toHaveLength(1);

    t.chart.prependBars(all.slice(312, 390));
    t.flush();
    expect(requests).toHaveLength(2); // still near the (new) oldest bar -> next page
    expect(requests[1]!.before).toBe(all[312]!.start);
  });

  test('hasMore=false stops requests until setData', () => {
    const requests: OlderDataRequest[] = [];
    const t = setup(all.slice(390), (r) => requests.push(r));
    t.pan(2000);
    t.chart.prependBars(all.slice(0, 390), { hasMore: false });
    t.flush();
    t.pan(3000);
    expect(requests).toHaveLength(1);
    expect(t.chart.getOlderDataState()).toBe('exhausted');
    t.chart.setBars(all.slice(390));
    expect(t.chart.getOlderDataState()).toBe('idle');
  });

  test('resolveOlderDataRequest without bars does not immediately re-request (no storm)', () => {
    const requests: OlderDataRequest[] = [];
    const t = setup(all.slice(390), (r) => requests.push(r));
    t.pan(2000);
    t.chart.resolveOlderDataRequest(true);
    t.flush();
    expect(requests).toHaveLength(1);
    t.pan(10); // the next user interaction may ask again
    expect(requests).toHaveLength(2);
  });

  test('destroy drops the callback', () => {
    const requests: OlderDataRequest[] = [];
    const t = setup(all.slice(390), (r) => requests.push(r));
    t.chart.destroy();
    t.chart.render();
    t.pan(2000);
    expect(requests).toHaveLength(0);
  });
});
