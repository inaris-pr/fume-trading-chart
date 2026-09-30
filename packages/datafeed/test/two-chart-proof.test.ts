/**
 * Embedding proof: two independent ChartSessions on one page (NQ 5m and ES 1h) share ONE
 * FumeApiDataFeed and therefore ONE stream connection. Uses a fake backend over `fetch` (canonical
 * candles built with @fume/core) and a fake WebSocket; no network. Also: two replay charts share
 * one replay stream.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildCanonicalBars,
  resolveWeeklySessions,
  type Bar,
  type InstrumentId,
  type MarketEvent,
  type TimeframeId,
} from '@fume/core';
import { ManualScheduler, ReplayDataset, ReplayMarketDataProvider } from '@fume/replay';
import {
  ChartSession,
  FumeApiDataFeed,
  ReplayDataFeed,
  type ChartSink,
  type SocketLike,
} from '../src/index.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 30, 17, 40);
const DELAYED_MINUTE = Math.floor((NOW - 10 * MIN) / MIN) * MIN;
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
  instrumentId: 'fut:X' as InstrumentId,
  spec: GLOBEX,
  from: '2026-09-01',
  to: '2026-10-20',
});
const FEED = { providerId: 'x', feedId: 'futures-delayed', consolidated: true, delayMs: 600_000 };

function instrument(root: string, contract: string) {
  return {
    id: `fut:${root}:2026-12`,
    assetClass: 'future',
    displaySymbol: contract,
    currency: 'USD',
    tickRules: [{ fromPrice: '0', tickSize: '0.25' }],
    priceFormat: { kind: 'decimal', decimals: 2 },
    quantityStep: '1',
    quantityUnit: 'contracts',
    contractMultiplier: '20',
    session: GLOBEX,
    tradable: false,
    shortable: 'unknown',
    marketDataRef: { providerId: 'x', symbol: contract },
  };
}

function minutes(base: number): Bar[] {
  const out: Bar[] = [];
  for (const s of CALENDAR) {
    for (const w of s.windows) {
      for (let t = w.start; t < Math.min(w.end, DELAYED_MINUTE); t += MIN) {
        const p = base + ((t / MIN) % 50) * 0.25;
        out.push({
          start: t,
          open: p,
          high: p + 1,
          low: p - 1,
          close: p,
          volume: 5,
          status: 'final',
          revision: 0,
        });
      }
    }
  }
  return out;
}
const SERIES: Record<string, Bar[]> = {
  'fut:NQ:2026-12': minutes(30_000),
  'fut:ES:2026-12': minutes(6_500),
};

/** Fake Fume backend over fetch (same URLs and shapes as /api/v1). */
const requests: string[] = [];
async function fakeFetch(input: string): Promise<Response> {
  requests.push(input);
  const url = new URL(input, 'http://localhost:5173');
  const q = url.searchParams;
  if (url.pathname === '/api/v1/instruments/resolve') {
    const root = q.get('symbol')!;
    const contract = { NQ: 'NQZ6', ES: 'ESZ6' }[root]!;
    return Response.json({
      instrument: instrument(root, contract),
      stream: { key: 'futures-delayed' },
    });
  }
  if (url.pathname === '/api/v1/sessions') {
    const from = Number(q.get('from'));
    const to = Number(q.get('to'));
    return Response.json({
      sessions: CALENDAR.filter((s) => s.windows[0]!.end > from && s.windows[0]!.start <= to),
    });
  }
  if (url.pathname === '/api/v1/bars') {
    const id = q.get('instrumentId')!;
    const timeframe = q.get('timeframe') as TimeframeId;
    const end = q.has('end') ? Number(q.get('end')) : undefined;
    const limit = Number(q.get('limit'));
    const all = buildCanonicalBars({
      baseBars: SERIES[id]!,
      baseIntervalMinutes: 1,
      sessions: CALENDAR,
      timeframe,
      mode: 'regular',
      asOf: NOW - 10 * MIN,
    }).bars.filter((b) => end === undefined || b.start < end);
    const bars = all.slice(-limit);
    return Response.json({
      meta: { instrumentId: id, timeframe, sessionMode: 'regular', feed: FEED },
      bars,
      hasMore: all.length > bars.length,
      serverTime: NOW,
    });
  }
  return Response.json(
    { error: { code: 'not_found', message: 'x', retryable: false } },
    { status: 404 },
  );
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private seq = 0;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
    const f = JSON.parse(d) as Record<string, unknown>;
    if (f.type === 'hello') this.serve({ type: 'welcome' });
    if (f.type === 'subscribe')
      this.serve({ type: 'subscribed', subId: f.subId, instrumentId: f.instrumentId });
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serve(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ ...frame, seq: ++this.seq }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

class Recorder implements ChartSink {
  data: Bar[] = [];
  setData(d: { bars: readonly Bar[] }) {
    this.data = [...d.bars];
  }
  upsertBars(bars: readonly Bar[]) {
    for (const b of bars) {
      const i = this.data.findIndex((x) => x.start === b.start);
      if (i >= 0) this.data[i] = b;
      else this.data = [...this.data, b].sort((a, c) => a.start - c.start);
    }
  }
  prependBars(bars: readonly Bar[]) {
    this.data = [...bars, ...this.data];
  }
  resolveOlderDataRequest() {}
}

const second = (id: string, start: number, price: number, volume: number): MarketEvent => ({
  kind: 'bar',
  instrumentId: id as InstrumentId,
  interval: '1s',
  phase: 'provisional',
  bar: {
    start,
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
    status: 'provisional',
    revision: 0,
  },
});

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('location', {
    href: 'http://localhost:5173/?source=api',
    host: 'localhost:5173',
    protocol: 'http:',
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('two charts on one page, one shared FumeApiDataFeed', () => {
  test('NQ 5m + ES 1h: one socket, two subscriptions, events routed to the right chart', async () => {
    const sockets: FakeSocket[] = [];
    const feed = new FumeApiDataFeed({
      fetch: fakeFetch,
      createWebSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const nqChart = new Recorder();
    const esChart = new Recorder();
    const nq = new ChartSession({ datafeed: feed, chart: nqChart });
    const es = new ChartSession({ datafeed: feed, chart: esChart });
    const loading = Promise.all([nq.select('NQ', '5m', 'future'), es.select('ES', '1h', 'future')]);
    expect(sockets).toHaveLength(0); // nothing opens before an instrument is resolved
    await loading;

    // ONE stream connection for both charts.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('ws://localhost:5173/api/v1/stream?key=futures-delayed');
    sockets[0]!.open();
    expect(sockets[0]!.sent.filter((f) => f.type === 'subscribe')).toEqual([
      { type: 'subscribe', subId: 's1', instrumentId: 'fut:NQ:2026-12', streams: ['market'] },
      { type: 'subscribe', subId: 's2', instrumentId: 'fut:ES:2026-12', streams: ['market'] },
    ]);
    expect(feed.streamDiagnostics()).toEqual({
      'futures-delayed': {
        socketsCreated: 1,
        open: true,
        subscriptions: 2,
        instruments: ['fut:ES:2026-12', 'fut:NQ:2026-12'],
      },
    });
    expect(nq.state()).toMatchObject({ symbol: 'NQZ6', timeframe: '5m', streaming: true });
    expect(es.state()).toMatchObject({ symbol: 'ESZ6', timeframe: '1h', streaming: true });

    // One market frame with both instruments: each chart updates only its own candle.
    const nqBefore = nqChart.data.at(-1)!;
    const esBefore = esChart.data.at(-1)!;
    sockets[0]!.serve({
      type: 'market',
      events: [
        second('fut:NQ:2026-12', DELAYED_MINUTE + 2_000, 31_000, 7),
        second('fut:ES:2026-12', DELAYED_MINUTE + 2_000, 6_000, 3),
      ],
    });
    const nqAfter = nqChart.data.at(-1)!;
    const esAfter = esChart.data.at(-1)!;
    expect(nqAfter.close).toBe(31_000);
    expect(esAfter.close).toBe(6_000);
    expect(nqAfter.start).toBeGreaterThanOrEqual(nqBefore.start);
    expect(esAfter.start).toBe(esBefore.start); // same 1h session bucket
    expect(esAfter.volume).toBe(esBefore.volume + 3);

    // A reconnect resyncs BOTH charts (two tail re-fetches), still over one connection.
    const before = requests.length;
    sockets[0]!.drop();
    await new Promise((r) => setTimeout(r, 900));
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await new Promise((r) => setTimeout(r, 20));
    const refetched = requests.slice(before).filter((u) => u.startsWith('/api/v1/bars'));
    expect(refetched.some((u) => u.includes('fut%3ANQ') && u.includes('timeframe=5m'))).toBe(true);
    expect(refetched.some((u) => u.includes('fut%3AES') && u.includes('timeframe=1h'))).toBe(true);

    nq.dispose();
    expect(feed.streamDiagnostics()['futures-delayed']!.subscriptions).toBe(1);
    es.dispose();
    feed.dispose();
    expect(sockets.every((s) => s.readyState === 3)).toBe(true);
  });
});

describe('two replay charts share one replay stream', () => {
  test('SPY 1m + AAPL 5m over one ReplayDataFeed open a single provider stream', async () => {
    const scheduler = new ManualScheduler();
    const provider = new ReplayMarketDataProvider({
      dataset: new ReplayDataset(),
      scheduler,
      speed: 60,
    });
    const openStream = vi.spyOn(provider, 'openStream');
    const feed = new ReplayDataFeed({ provider, olderPageDelayMs: 0 });
    const a = new Recorder();
    const b = new Recorder();
    const s1 = new ChartSession({ datafeed: feed, chart: a });
    const s2 = new ChartSession({ datafeed: feed, chart: b });
    await Promise.all([s1.select('SPY', '1m'), s2.select('AAPL', '5m')]);
    expect(openStream).toHaveBeenCalledTimes(1);
    const aLast = a.data.at(-1)!.start;
    scheduler.advance(3_000);
    expect(a.data.at(-1)!.start).toBeGreaterThan(aLast); // SPY live
    expect(b.data.at(-1)!.start).toBeGreaterThanOrEqual(aLast - 5 * MIN); // AAPL live
    s1.dispose();
    s2.dispose();
    expect(scheduler.pendingTimers()).toBe(0); // the shared stream closed with the last chart
    feed.dispose();
  });
});
