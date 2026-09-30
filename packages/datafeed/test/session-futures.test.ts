/**
 * Delayed futures in the API chart controller, against a fake Fume backend (canonical candles built
 * with @fume/core from synthetic 1-minute bars inside Globex sessions) and a fake stream
 * connection. No network, no provider, no live data.
 *
 * Covers: root resolution by asset class, subscribe + buffer + handoff, per-second aggregates moving
 * the delayed current candle, the authoritative minute replacing it, higher-timeframe updates with
 * session alignment, duplicate seconds, soft resync after a stream reconnect, left paging, and
 * "latest" = newest delayed data.
 */
import { describe, expect, test } from 'vitest';
import {
  aggregateBars,
  buildCanonicalBars,
  createSessionTimeScale,
  resolveWeeklySessions,
  slotSpecForTimeframe,
  type AssetClass,
  type Bar,
  type Instrument,
  type InstrumentId,
  type MarketEvent,
  type MarketSession,
  type StreamState,
  type TimeframeId,
  type UnixMs,
} from '@fume/core';
import { ChartSession, type ChartStatus } from '../src/session.ts';
import type {
  BarsPage,
  BarsQuery,
  ChartSink,
  DataFeed,
  LiveHandlers,
  LiveSubscription,
  ResolveOptions,
} from '../src/types.ts';

const SEC = 1_000;
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30, 17, 40); // Wed 12:40 CT
const DELAY = 10 * MIN;
const DELAYED_NOW = NOW - DELAY;
const NQ = 'fut:NQ:2026-12' as InstrumentId;
const FEED = {
  providerId: 'massive',
  feedId: 'futures-delayed',
  consolidated: true,
  delayMs: DELAY,
  displayName: 'CME futures',
};

const GLOBEX = {
  timezone: 'America/Chicago',
  regular: ([7, 1, 2, 3, 4] as const).map((startDay) => ({
    startDay,
    start: '17:00',
    end: '16:00',
  })),
  extended: [],
  calendarId: 'CME-GLOBEX',
};
const CALENDAR = resolveWeeklySessions({
  instrumentId: NQ,
  spec: GLOBEX,
  from: '2026-09-01',
  to: '2026-10-20',
});

function futureInstrument(): Instrument {
  return {
    id: NQ,
    assetClass: 'future',
    displaySymbol: 'NQZ6',
    description: 'E-mini Nasdaq-100 Index Futures · Dec 2026',
    exchange: 'XCME',
    currency: 'USD',
    tickRules: [{ fromPrice: '0', tickSize: '0.25' }],
    priceFormat: { kind: 'decimal', decimals: 2 },
    quantityStep: '1',
    quantityUnit: 'contracts',
    contractMultiplier: '20',
    session: GLOBEX,
    tradable: false,
    shortable: 'unknown',
    future: { rootSymbol: 'NQ', contractMonth: '2026-12', expiration: 0, tickValue: '5' },
    marketDataRef: { providerId: 'massive', symbol: 'NQZ6' },
  };
}

/** One synthetic minute per open minute up to (not including) the delayed "now" minute. */
function minutesUpTo(end: UnixMs): Bar[] {
  const out: Bar[] = [];
  for (const s of CALENDAR) {
    for (const w of s.windows) {
      for (let t = w.start; t < Math.min(w.end, end); t += MIN) {
        const p = 30_000 + ((t / MIN) % 97) * 0.25;
        out.push({
          start: t,
          open: p,
          high: p + 1,
          low: p - 0.5,
          close: p + 0.5,
          volume: 10,
          tradeCount: 4,
          status: 'final',
          revision: 0,
        });
      }
    }
  }
  return out;
}

/** One live subscription the session opened on the fake feed. */
class FakeSub implements LiveSubscription {
  active = true;
  constructor(
    readonly instrumentId: InstrumentId,
    readonly handlers: LiveHandlers,
  ) {}
  unsubscribe(): void {
    this.active = false;
  }
}

class FakeFuturesBackend implements DataFeed {
  readonly subs: FakeSub[] = [];
  readonly barsCalls: BarsQuery[] = [];
  readonly resolveCalls: [string, AssetClass | undefined][] = [];
  gate: Promise<void> | null = null;
  minutes = minutesUpTo(Math.floor(DELAYED_NOW / MIN) * MIN);

  async resolveInstrument(symbol: string, options: ResolveOptions = {}) {
    const assetClass: AssetClass | undefined = options.assetClass;
    this.resolveCalls.push([symbol, assetClass]);
    if (assetClass !== 'future') {
      const instrument = {
        ...futureInstrument(),
        id: `eq:${symbol}` as InstrumentId,
        assetClass: 'equity' as const,
      };
      return { instrument, live: false };
    }
    return { instrument: futureInstrument(), live: true };
  }

  subscribe(instrumentId: InstrumentId, handlers: LiveHandlers): LiveSubscription {
    const sub = new FakeSub(instrumentId, handlers);
    this.subs.push(sub);
    return sub;
  }

  dispose(): void {}

  async getSessions(_id: InstrumentId, from: UnixMs, to: UnixMs): Promise<MarketSession[]> {
    return CALENDAR.filter((s) => s.windows[0]!.end > from && s.windows[0]!.start <= to);
  }

  async getBars(query: BarsQuery): Promise<BarsPage> {
    this.barsCalls.push(query);
    if (this.gate) await this.gate;
    const all = buildCanonicalBars({
      baseBars: this.minutes,
      baseIntervalMinutes: 1,
      sessions: CALENDAR,
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
      serverTime: NOW,
    };
  }
}

class Recorder implements ChartSink {
  data: Bar[] = [];
  setDataCalls = 0;
  upserts: Bar[][] = [];
  prepends: Bar[][] = [];
  setData(d: { bars: readonly Bar[] }) {
    this.data = [...d.bars];
    this.setDataCalls++;
  }
  upsertBars(bars: readonly Bar[]) {
    this.upserts.push([...bars]);
    for (const b of bars) {
      const i = this.data.findIndex((x) => x.start === b.start);
      if (i >= 0) this.data[i] = b;
      else this.data = [...this.data, b].sort((a, c) => a.start - c.start);
    }
  }
  prependBars(bars: readonly Bar[]) {
    this.prepends.push([...bars]);
    this.data = [...bars, ...this.data];
  }
  resolveOlderDataRequest() {}
}

function setup() {
  const backend = new FakeFuturesBackend();
  const chart = new Recorder();
  const statuses: ChartStatus[] = [];
  const states: (StreamState | null)[] = [];
  const controller = new ChartSession({
    datafeed: backend,
    chart,
    onStatus: (s) => statuses.push(s),
    onStreamState: (s) => states.push(s),
  });
  return { backend, chart, statuses, states, streams: backend.subs, controller };
}

const sec = (
  start: UnixMs,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): MarketEvent => ({
  kind: 'bar',
  instrumentId: NQ,
  interval: '1s',
  phase: 'provisional',
  bar: { start, open: o, high: h, low: l, close: c, volume: v, status: 'provisional', revision: 0 },
});
const minute = (
  start: UnixMs,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): MarketEvent => ({
  kind: 'bar',
  instrumentId: NQ,
  interval: '1m',
  phase: 'final',
  bar: { start, open: o, high: h, low: l, close: c, volume: v, status: 'final', revision: 0 },
});

/** The delayed minute the stream is currently producing. */
const CURRENT = Math.floor(DELAYED_NOW / MIN) * MIN;

describe('delayed futures: load + live handoff', () => {
  test('a futures root resolves by asset class, subscribes the contract and reports a delayed stream', async () => {
    const { backend, controller, streams, statuses, chart } = setup();
    await controller.select('NQ', '5m', 'future');
    expect(backend.resolveCalls).toEqual([['NQ', 'future']]);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.instrumentId).toBe(NQ);
    expect(streams[0]!.active).toBe(true);
    // History for the displayed timeframe plus a 1m seed for the live aggregator.
    expect(backend.barsCalls.map((q) => q.timeframe)).toEqual(['5m', '1m']);
    const ready = statuses.at(-1) as Extract<ChartStatus, { kind: 'ready' }>;
    expect(ready).toMatchObject({ kind: 'ready', symbol: 'NQZ6', streaming: true });
    expect(ready.instrument.future!.rootSymbol).toBe('NQ');
    expect(ready.feed).toMatchObject({ delayMs: DELAY, displayName: 'CME futures' });
    // Latest = the newest DELAYED bucket; nothing up to wall-clock time.
    expect(chart.data.at(-1)!.start).toBeLessThanOrEqual(DELAYED_NOW);
    // The newest delayed minute with data is CURRENT - 1 min; its 5m bucket is the last candle.
    expect(chart.data.at(-1)!.start).toBe(Math.floor((CURRENT - MIN) / (5 * MIN)) * 5 * MIN);
  });

  test('events arriving while history loads are buffered and applied after the seed', async () => {
    const { backend, controller, streams, chart } = setup();
    let release!: () => void;
    backend.gate = new Promise((r) => (release = r));
    const loading = controller.select('NQ', '1m', 'future');
    await Promise.resolve();
    await Promise.resolve();
    streams[0]!.handlers.onEvents([sec(CURRENT + 2 * SEC, 30100, 30101, 30099, 30100.5, 7)]);
    release();
    await loading;
    const last = chart.data.at(-1)!;
    expect(last).toMatchObject({
      start: CURRENT,
      open: 30100,
      close: 30100.5,
      volume: 7,
      status: 'provisional',
    });
  });
});

describe('per-second aggregates -> delayed current candle; minute aggregate finalizes', () => {
  test('1m: seconds move the provisional minute; the minute aggregate replaces it', async () => {
    const { controller, streams, chart } = setup();
    await controller.select('NQ', '1m', 'future');
    const h = streams[0]!.handlers;
    h.onEvents([sec(CURRENT + 1 * SEC, 30200, 30202, 30199, 30201, 3)]);
    expect(chart.data.at(-1)).toMatchObject({
      start: CURRENT,
      open: 30200,
      high: 30202,
      low: 30199,
      close: 30201,
      volume: 3,
    });
    h.onEvents([sec(CURRENT + 7 * SEC, 30201, 30210, 30195, 30205, 5)]);
    expect(chart.data.at(-1)).toMatchObject({
      open: 30200,
      high: 30210,
      low: 30195,
      close: 30205,
      volume: 8,
      status: 'provisional',
    });
    // Re-delivered second: replaced, not double counted.
    h.onEvents([sec(CURRENT + 7 * SEC, 30201, 30210, 30195, 30205, 5)]);
    expect(chart.data.at(-1)!.volume).toBe(8);
    // Authoritative minute (includes seconds the stream never delivered).
    h.onEvents([minute(CURRENT, 30200, 30212, 30190, 30207, 20)]);
    expect(chart.data.at(-1)).toMatchObject({
      open: 30200,
      high: 30212,
      low: 30190,
      close: 30207,
      volume: 20,
      status: 'final',
    });
    // Late seconds for a finalized minute change nothing.
    h.onEvents([sec(CURRENT + 59 * SEC, 1, 1, 1, 1, 1)]);
    expect(chart.data.at(-1)!.close).toBe(30207);
    // The next delayed minute appears as a new candle (never ahead of the delayed data).
    h.onEvents([sec(CURRENT + MIN + 3 * SEC, 30207, 30208, 30206, 30208, 2)]);
    expect(chart.data.at(-1)!.start).toBe(CURRENT + MIN);
  });

  test('5m / 15m / 1h / 4h / 1d candles update from canonical minutes with session alignment', async () => {
    for (const tf of ['5m', '15m', '1h', '4h', '1d'] as TimeframeId[]) {
      const { controller, streams, chart, backend } = setup();
      await controller.select('NQ', tf, 'future');
      // Bucket of the delayed current minute on the session grid (session opens 22:00Z).
      const mapping = createSessionTimeScale({
        sessions: CALENDAR,
        sessionMode: 'regular',
        slot: slotSpecForTimeframe(tf),
      });
      const bucketStart = mapping.slotStart(Math.floor(mapping.toSlot(CURRENT)!));
      const before = chart.data.find((b) => b.start === bucketStart);
      streams[0]!.handlers.onEvents([sec(CURRENT + 5 * SEC, 29000, 29000, 28000, 28500, 1000)]);
      const after = chart.data.at(-1)!;
      expect(after.start).toBe(bucketStart);
      expect(after.low).toBe(28000);
      expect(after.close).toBe(28500);
      expect(after.volume).toBe((before?.volume ?? 0) + 1000);
      expect(after.status).toBe('provisional');
      // And it equals core aggregation of the backend minutes + the second-built minute.
      const minutes = [
        ...backend.minutes.filter((m) => m.start >= after.start),
        {
          start: CURRENT,
          open: 29000,
          high: 29000,
          low: 28000,
          close: 28500,
          volume: 1000,
          status: 'provisional' as const,
          revision: 0,
        },
      ];
      const [expected] = aggregateBars({
        bars: minutes,
        sourceDurationMs: MIN,
        target: mapping,
      }).bars.slice(-1);
      expect(after).toMatchObject({
        open: expected!.open,
        high: expected!.high,
        low: expected!.low,
        close: expected!.close,
        volume: expected!.volume,
      });
    }
  });

  test('4h buckets of the Globex session start at 22:00Z / 02:00Z / ... (session-aligned)', async () => {
    const { controller, chart } = setup();
    await controller.select('NQ', '4h', 'future');
    const hours = new Set(chart.data.map((b) => new Date(b.start).getUTCHours()));
    expect([...hours].sort((a, b) => a - b)).toEqual([2, 6, 10, 14, 18, 22]);
  });
});

describe('recovery, switching and paging', () => {
  test('stream resync: the tail is re-fetched without clearing the chart; the live state is rebuilt', async () => {
    const { controller, streams, chart, backend } = setup();
    await controller.select('NQ', '15m', 'future');
    const setDataCalls = chart.setDataCalls;
    // Minutes "missed" while disconnected now exist in the backend's canonical history.
    backend.minutes = [
      ...backend.minutes,
      {
        start: CURRENT,
        open: 31000,
        high: 31005,
        low: 30995,
        close: 31001,
        volume: 50,
        status: 'final',
        revision: 0,
      },
    ];
    const calls = backend.barsCalls.length;
    streams[0]!.handlers.onResync('reconnected');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(chart.setDataCalls).toBe(setDataCalls); // no clear / no view reset
    expect(backend.barsCalls.slice(calls).map((q) => q.timeframe)).toEqual(['15m', '1m']);
    expect(chart.data.at(-1)!.high).toBe(31005);
    // Live updates continue on the rebuilt state.
    streams[0]!.handlers.onEvents([sec(CURRENT + MIN + SEC, 31001, 31050, 31001, 31040, 1)]);
    expect(chart.data.at(-1)!.high).toBe(31050);
  });

  test('switching timeframe keeps the subscription; switching to an equity stops streaming', async () => {
    const { controller, streams, states } = setup();
    await controller.select('NQ', '5m', 'future');
    await controller.setTimeframe('1h');
    expect(streams).toHaveLength(1);
    expect(streams[0]!.active).toBe(true);
    await controller.select('SPY', '1h', 'equity');
    expect(streams[0]!.active).toBe(false);
    expect(states.at(-1)).toBeNull();
    await controller.select('NQ', '1h', 'future');
    expect(streams).toHaveLength(2);
    controller.dispose();
    expect(streams[1]!.active).toBe(false);
  });

  test('left paging for futures prepends strictly older canonical candles', async () => {
    const { controller, chart } = setup();
    await controller.select('NQ', '15m', 'future');
    const oldest = chart.data[0]!.start;
    await controller.requestOlderData({ before: oldest } as never);
    const page = chart.prepends[0]!;
    expect(page.length).toBeGreaterThan(0);
    expect(page.every((b) => b.start < oldest)).toBe(true);
    expect(page.at(-1)!.start).toBe(oldest - 15 * MIN);
  });

  test('a stream error during load never leaves an unbounded buffer', async () => {
    const { controller, streams, backend } = setup();
    backend.getBars = async () => {
      throw new Error('down');
    };
    await controller.select('NQ', '5m', 'future');
    streams[0]!.handlers.onEvents(
      Array.from({ length: 100 }, (_, i) => sec(CURRENT + i * SEC, 1, 1, 1, 1, 1)),
    );
    expect(controller.state()).toBeNull();
    // Nothing retained: the handler dropped the events (no loaded series, no buffer).
    expect(
      (controller as unknown as { streaming: { buffer: unknown } }).streaming.buffer,
    ).toBeNull();
  });
});

test('fixture sanity: the synthetic minutes end before the delayed now', () => {
  const m = minutesUpTo(CURRENT);
  expect(m.at(-1)!.start).toBe(CURRENT - MIN);
  expect(m.every((b) => b.start < NOW - DELAY)).toBe(true);
  expect(DAY).toBe(86_400_000);
});
