/**
 * ChartSession against a fake Fume backend DataFeed (no network, no provider). The fake builds
 * canonical candles with @fume/core exactly like the Worker does, from synthetic minutes.
 */
import { describe, expect, test } from 'vitest';
import {
  buildCanonicalBars,
  EMPTY_TIME_SCALE,
  resolveWeeklySessions,
  type Bar,
  type Instrument,
  type InstrumentId,
  type MarketSession,
  type TimeframeId,
  type TimeScaleMapping,
  type UnixMs,
} from '@fume/core';
import { generateSyntheticBars } from '@fume/core/fixtures';
import { FumeChart, type ChartData, type PrependOptions } from '@fume/chart';
import { FakeEnvironment, fakeContainer, pointer } from '../../../packages/chart/test/fakes.ts';
import { FumeApiError } from '../src/api/http-client.ts';
import { HISTORY_PAGE } from '../src/defaults.ts';
import type { BarsPage, BarsQuery, ChartSink, DataFeed } from '../src/types.ts';
import { ChartSession, type ChartStatus } from '../src/session.ts';

const TIMEFRAME_ORDER: readonly TimeframeId[] = ['1d', '4h', '1h', '15m', '5m', '1m'];

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 16, 0); // Saturday after the last data session
const FEED = { providerId: 'alpaca', feedId: 'iex', consolidated: false, delayMs: 0 };

function instrument(symbol: string): Instrument {
  return {
    id: `eq:${symbol}` as InstrumentId,
    assetClass: 'equity',
    displaySymbol: symbol,
    currency: 'USD',
    tickRules: [{ fromPrice: '0', tickSize: '0.01' }],
    priceFormat: { kind: 'decimal', decimals: 2 },
    quantityStep: '1',
    quantityUnit: 'shares',
    contractMultiplier: '1',
    session: { timezone: 'America/New_York', regular: [], extended: [], calendarId: 'X' },
    tradable: true,
    shortable: true,
    marketDataRef: { providerId: 'fake', symbol },
  };
}

const weekdays = (start: string, end: string) =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));
const CALENDAR = resolveWeeklySessions({
  instrumentId: 'eq:X' as InstrumentId,
  spec: {
    timezone: 'America/New_York',
    regular: weekdays('09:30', '16:00'),
    extended: [],
    calendarId: 'X',
  },
  from: '2026-06-01',
  to: '2026-10-16',
});
const DATA_SESSIONS = CALENDAR.filter((s) => s.windows[0]!.end <= NOW);

/** Fake backend: canonical candles via @fume/core; optional gates to control response timing. */
class FakeBackend implements DataFeed {
  readonly barsCalls: BarsQuery[] = [];
  readonly sessionCalls: [UnixMs, UnixMs][] = [];
  readonly signals: AbortSignal[] = [];
  gate: Promise<void> | null = null;
  failNext: FumeApiError | null = null;
  private readonly minutes = new Map<string, Bar[]>();

  private series(symbol: string): Bar[] {
    let m = this.minutes.get(symbol);
    if (!m) {
      m = generateSyntheticBars({
        seed: symbol.charCodeAt(0),
        sessions: DATA_SESSIONS,
        sessionMode: 'regular',
        durationMs: MIN,
        count: DATA_SESSIONS.length * 390,
        startPrice: symbol === 'SPY' ? 600 : 120,
        tickSize: 0.01,
        walk: 'multiplicative',
        volatility: 0.001,
        gapVolatility: 0.01,
        dojiProbability: 0.05,
        longWickProbability: 0.02,
        baseVolume: 1000,
      });
      this.minutes.set(symbol, m);
    }
    return m;
  }

  private async wait(signal?: AbortSignal) {
    if (signal) this.signals.push(signal);
    if (this.gate) await this.gate;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async resolveInstrument(symbol: string, options: { signal?: AbortSignal } = {}) {
    await this.wait(options.signal);
    return { instrument: instrument(symbol), live: false };
  }

  subscribe() {
    return null; // history only
  }

  dispose() {}

  async getSessions(
    _id: InstrumentId,
    from: UnixMs,
    to: UnixMs,
    signal?: AbortSignal,
  ): Promise<MarketSession[]> {
    this.sessionCalls.push([from, to]);
    await this.wait(signal);
    return CALENDAR.filter((s) => s.windows[0]!.end > from && s.windows[0]!.start <= to);
  }

  async getBars(query: BarsQuery): Promise<BarsPage> {
    this.barsCalls.push(query);
    await this.wait(query.signal);
    const symbol = query.instrumentId.slice(3);
    const all = buildCanonicalBars({
      baseBars: this.series(symbol),
      baseIntervalMinutes: 1,
      sessions: DATA_SESSIONS,
      timeframe: query.timeframe,
      mode: 'regular',
      asOf: NOW,
    }).bars;
    const before = all.filter((b) => query.end === undefined || b.start < query.end);
    const bars = before.slice(-query.limit);
    return {
      meta: {
        instrumentId: query.instrumentId,
        timeframe: query.timeframe,
        sessionMode: 'regular',
        feed: FEED,
      },
      bars,
      hasMore: before.length > bars.length,
      serverTime: NOW + this.barsCalls.length * 5_000, // the server clock advances like a real one
    };
  }
}

class RecordingChart implements ChartSink {
  readonly data: ChartData[] = [];
  readonly prepends: { bars: readonly Bar[]; options?: PrependOptions }[] = [];
  readonly resolved: boolean[] = [];
  setData(data: ChartData) {
    this.data.push(data);
  }
  upsertBars() {
    throw new Error('historical mode never upserts');
  }
  prependBars(bars: readonly Bar[], options?: PrependOptions) {
    this.prepends.push({ bars, ...(options ? { options } : {}) });
  }
  resolveOlderDataRequest(hasMore: boolean) {
    this.resolved.push(hasMore);
  }
  get last() {
    return this.data.at(-1)!;
  }
}

function setup() {
  const backend = new FakeBackend();
  const chart = new RecordingChart();
  const statuses: ChartStatus[] = [];
  const controller = new ChartSession({
    datafeed: backend,
    chart,
    onStatus: (s) => statuses.push(s),
  });
  return { backend, chart, statuses, controller };
}

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const nyHHMM = (t: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);

describe('ChartSession (backend DataFeed, history)', () => {
  test('loads SPY: clears first, then canonical bars with a mapping that covers them and future sessions', async () => {
    const { chart, statuses, controller, backend } = setup();
    await controller.select('SPY', '1h');
    expect(chart.data[0]!.bars).toEqual([]); // cleared immediately
    const data = chart.last;
    expect(data.bars).toHaveLength(HISTORY_PAGE['1h']);
    for (const b of data.bars) expect(data.timeScale.toSlot(b.start)).not.toBeNull();
    const lastSlot = data.timeScale.toSlot(data.bars.at(-1)!.start)!;
    expect(data.timeScale.slotStart(lastSlot + 7)).toBeGreaterThan(NOW); // real future session slots
    expect(backend.barsCalls[0]).toMatchObject({
      instrumentId: 'eq:SPY',
      timeframe: '1h',
      limit: HISTORY_PAGE['1h'],
    });
    expect(backend.barsCalls[0]!.end).toBeUndefined();
    expect(statuses.map((s) => s.kind)).toEqual(['loading', 'ready']);
    const ready = statuses[1] as Extract<ChartStatus, { kind: 'ready' }>;
    expect(ready.feed).toEqual(FEED);
    expect(ready.streaming).toBe(false);
    expect(data.bars.slice(-7).map((b) => nyHHMM(b.start))).toEqual([
      '09:30',
      '10:30',
      '11:30',
      '12:30',
      '13:30',
      '14:30',
      '15:30',
    ]);
  });

  test('all six timeframes load canonical candles from the backend (never re-aggregated locally)', async () => {
    const { chart, controller, backend } = setup();
    await controller.select('SPY', '1d');
    for (const tf of TIMEFRAME_ORDER) {
      await controller.setTimeframe(tf);
      const data = chart.last;
      expect(backend.barsCalls.at(-1)!.timeframe).toBe(tf);
      expect(data.bars.length, tf).toBeGreaterThan(0);
      expect(data.bars.length).toBeLessThanOrEqual(HISTORY_PAGE[tf]);
      const slots = data.bars.map((b) => data.timeScale.toSlot(b.start)!);
      expect(
        slots.every((s) => Number.isInteger(s)),
        tf,
      ).toBe(true);
      expect(new Set(slots).size).toBe(slots.length);
    }
    const fourH = await (async () => {
      await controller.setTimeframe('4h');
      return chart.last.bars.slice(-2).map((b) => nyHHMM(b.start));
    })();
    expect(fourH).toEqual(['09:30', '13:30']);
  });

  test('sessions are cached per instrument: a timeframe switch fetches no new calendar range', async () => {
    const { controller, backend } = setup();
    await controller.select('SPY', '1d'); // widest range first
    const calls = backend.sessionCalls.length;
    await controller.setTimeframe('1h');
    await controller.setTimeframe('5m');
    expect(backend.sessionCalls.length).toBe(calls);
  });

  test('symbol switch clears the chart before the new symbol arrives (no stale bars)', async () => {
    const { chart, controller } = setup();
    await controller.select('SPY', '15m');
    const spyClose = chart.last.bars.at(-1)!.close;
    const pending = controller.select('NVDA', '15m');
    expect(chart.last.bars).toEqual([]);
    await pending;
    expect(chart.last.bars.at(-1)!.close).not.toBe(spyClose);
    expect(chart.last.bars.at(-1)!.close).toBeLessThan(400);
  });

  test('a stale response is ignored and its request aborted', async () => {
    const { chart, controller, backend } = setup();
    await controller.select('SPY', '1h');
    const gate = deferred();
    backend.gate = gate.promise;
    const spy = controller.select('QQQ', '1h'); // will be superseded
    const firstSignal = backend.signals.at(-1)!;
    const nvda = controller.select('NVDA', '1h');
    expect(firstSignal.aborted).toBe(true);
    backend.gate = null;
    gate.release();
    await Promise.all([spy, nvda]);
    const withBars = chart.data.filter((d) => d.bars.length > 0);
    expect(withBars.at(-1)!.bars.at(-1)!.close).toBeLessThan(400); // NVDA-like series, not QQQ
    expect(controller.state()?.symbol).toBe('NVDA');
    expect(backend.barsCalls.filter((c) => c.instrumentId === 'eq:QQQ')).toHaveLength(0);
  });

  test('older data: end = oldest loaded start, prepend with a wider mapping, one request in flight', async () => {
    const { chart, controller, backend } = setup();
    await controller.select('SPY', '1h');
    const oldest = chart.last.bars[0]!.start;
    const gate = deferred();
    backend.gate = gate.promise;
    const first = controller.requestOlderData({ before: oldest });
    const second = controller.requestOlderData({ before: oldest }); // ignored while in flight
    backend.gate = null;
    gate.release();
    await Promise.all([first, second]);
    const olderCalls = backend.barsCalls.filter((c) => c.end !== undefined);
    expect(olderCalls).toHaveLength(1);
    expect(olderCalls[0]!.end).toBe(oldest);
    const prepend = chart.prepends[0]!;
    expect(prepend.bars.at(-1)!.start).toBeLessThan(oldest);
    const scale = prepend.options!.timeScale!;
    for (const b of [...prepend.bars, ...chart.last.bars])
      expect(scale.toSlot(b.start)).not.toBeNull();
    expect(controller.state()!.oldest).toBe(prepend.bars[0]!.start);
  });

  test('hasMore false stops paging permanently for the dataset', async () => {
    const { chart, controller, backend } = setup();
    await controller.select('SPY', '1d'); // 300 daily candles cover the whole fake history
    await controller.requestOlderData({ before: chart.last.bars[0]!.start });
    const calls = backend.barsCalls.length;
    // Page until exhausted.
    for (let i = 0; i < 5; i++) await controller.requestOlderData({ before: 0 });
    expect(controller.state()!.hasMore).toBe(false);
    const after = backend.barsCalls.length;
    await controller.requestOlderData({ before: 0 });
    expect(backend.barsCalls.length).toBe(after);
    expect(chart.resolved.at(-1)).toBe(false);
    expect(after).toBeLessThanOrEqual(calls + 1);
  });

  test('a timeframe switch invalidates an in-flight older-data request', async () => {
    const { chart, controller, backend } = setup();
    await controller.select('SPY', '1h');
    const gate = deferred();
    backend.gate = gate.promise;
    const older = controller.requestOlderData({ before: chart.last.bars[0]!.start });
    const switched = controller.setTimeframe('4h');
    backend.gate = null;
    gate.release();
    await Promise.all([older, switched]);
    expect(chart.prepends).toHaveLength(0);
    expect(controller.state()!.timeframe).toBe('4h');
  });

  test('errors surface as a status; older-data errors do not retry in a loop', async () => {
    const { chart, statuses, controller, backend } = setup();
    backend.failNext = new FumeApiError(
      503,
      'unavailable',
      'Market data is not configured on this backend',
      false,
    );
    await controller.select('SPY', '1h');
    expect(statuses.at(-1)).toMatchObject({ kind: 'error', code: 'unavailable', symbol: 'SPY' });
    await controller.select('SPY', '1h');
    const calls = backend.barsCalls.length;
    backend.failNext = new FumeApiError(429, 'rate_limited', 'slow down', true, 60_000);
    await controller.requestOlderData({ before: chart.last.bars[0]!.start });
    expect(backend.barsCalls.length).toBe(calls + 1);
    expect(chart.resolved.at(-1)).toBe(true); // chart keeps its data; asks again only on interaction
    expect(statuses.at(-1)).toMatchObject({ kind: 'error', code: 'rate_limited' });
  });

  test('dispose aborts in-flight work', async () => {
    const { controller, backend, chart } = setup();
    const gate = deferred();
    backend.gate = gate.promise;
    const pending = controller.select('SPY', '1h');
    controller.dispose();
    gate.release();
    await pending;
    expect(backend.signals[0]!.aborted).toBe(true);
    expect(chart.data.filter((d) => d.bars.length > 0)).toHaveLength(0);
  });
});

describe('real FumeChart integration: older history prepends without a visual jump', () => {
  test('pan left loads older canonical candles; zoom, MANUAL price range and picture stay put', async () => {
    const env = new FakeEnvironment();
    const chart = new FumeChart(
      fakeContainer(),
      {
        timeScale: EMPTY_TIME_SCALE,
        formatPrice: (p) => p.toFixed(2),
        formatTime: () => '',
        minPriceStep: 0.01,
      },
      env,
    );
    env.resizeCallback!({ cssWidth: 1000, cssHeight: 600 });
    let scale: TimeScaleMapping | null = null;
    const sink: ChartSink = {
      setData: (d) => {
        scale = d.timeScale;
        chart.setData(d);
      },
      upsertBars: (b) => chart.upsertBars(b),
      prependBars: (b, o) => {
        if (o?.timeScale) scale = o.timeScale;
        return chart.prependBars(b, o);
      },
      resolveOlderDataRequest: (h) => chart.resolveOlderDataRequest(h),
    };
    const backend = new FakeBackend();
    const requests: number[] = [];
    const controller = new ChartSession({ datafeed: backend, chart: sink });
    chart.setOptions({
      onNeedsOlderData: (r) => void (requests.push(r.before), controller.requestOlderData(r)),
    });
    await controller.select('SPY', '15m');
    env.flushFrames();
    const overlay = env.canvases[1]!;
    const frame = () => chart.getLastFrame()!;

    // MANUAL price scale via the axis, then pan left towards the oldest candle.
    const axisX = frame().layout.priceAxis.x + 10;
    overlay.dispatch('pointerdown', pointer(axisX, 300));
    overlay.dispatch('pointermove', pointer(axisX, 260));
    overlay.dispatch('pointerup', pointer(axisX, 260));
    env.flushFrames();
    for (let i = 0; i < 12 && requests.length === 0; i++) {
      overlay.dispatch('pointerdown', pointer(200, 300));
      overlay.dispatch('pointermove', pointer(900, 300));
      overlay.dispatch('pointerup', pointer(900, 300));
      env.flushFrames();
    }
    expect(requests).toHaveLength(1);

    const timeAt = (x: number) => scale!.slotStart(Math.floor(frame().viewport.xToSlot(x)));
    const beforeTimes = [100, 400, 800].map(timeAt);
    const spacing = chart.getView().barSpacing;
    const range = { ...frame().priceScale!.range };
    const barsBefore = chart.getBarCount();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    env.flushFrames();
    expect(chart.getBarCount()).toBeGreaterThan(barsBefore);
    expect([100, 400, 800].map(timeAt)).toEqual(beforeTimes);
    expect(chart.getView().barSpacing).toBe(spacing);
    expect(chart.getPriceScaleMode()).toBe('manual');
    expect(frame().priceScale!.range).toEqual(range);
    expect(backend.barsCalls.filter((c) => c.end !== undefined)).toHaveLength(1);
    chart.destroy();
  });
});
