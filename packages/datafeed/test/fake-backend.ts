/**
 * Shared test doubles for Fume's backend API (used by @fume/datafeed and @fume/react tests): a fake
 * `/api/v1` over fetch (Globex sessions, canonical candles built with @fume/core from synthetic
 * minutes, futures roots NQ and ES) and a fake stream WebSocket that answers hello/subscribe.
 */
import {
  buildCanonicalBars,
  resolveWeeklySessions,
  type Bar,
  type InstrumentId,
  type TimeframeId,
} from '@fume/core';
import type { SocketLike } from '../src/index.ts';

export const MIN = 60_000;
export const NOW = Date.UTC(2026, 8, 30, 17, 40);
export const DELAYED_MINUTE = Math.floor((NOW - 10 * MIN) / MIN) * MIN;
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
export const requests: string[] = [];
export async function fakeFetch(input: string): Promise<Response> {
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

export class FakeSocket implements SocketLike {
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
