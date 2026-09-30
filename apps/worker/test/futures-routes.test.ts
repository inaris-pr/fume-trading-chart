/**
 * Futures through the real composition root (src/index.ts): provider-neutral routing by asset
 * class / id namespace / providerId, canonical session-aligned candles from Massive 1-minute bars,
 * sessions, the stream-upgrade route, error reasons, and no credential in any response or log.
 * `fetch` is stubbed by the offline FakeAlpaca + FakeMassive.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Bar } from '@fume/core';
import { FakeAlpaca, TEST_KEY_ID, TEST_SECRET } from './fake-alpaca.ts';
import { FakeMassive, MASSIVE_ENV, TEST_MASSIVE_KEY } from './fake-massive.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 30, 17, 40); // Wed 12:40 CT

const forwarded: Request[] = [];
const FEED_HUB = {
  idFromName: (name: string) => ({ name }),
  get: (id: { name: string }) => ({
    fetch: async (request: Request) => {
      forwarded.push(request);
      return new Response(`hub:${id.name}`, { status: 200 });
    },
  }),
};

const ENV = {
  FUME_ENV: 'local',
  ALPACA_DATA_BASE_URL: 'https://data.alpaca.markets',
  ALPACA_TRADING_BASE_URL: 'https://paper-api.alpaca.markets',
  ALPACA_DATA_FEED: 'iex',
  FUME_ALLOWED_ORIGINS: 'http://localhost:5173',
  ALPACA_API_KEY_ID: TEST_KEY_ID,
  ALPACA_API_SECRET_KEY: TEST_SECRET,
  ...MASSIVE_ENV,
  FEED_HUB,
};

let massive: FakeMassive;
let logs: string[];
let worker: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const alpaca = new FakeAlpaca({ now: NOW });
  massive = new FakeMassive({ now: NOW });
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith('https://api.massive.com')
      ? massive.fetch(input, init)
      : alpaca.fetch(input as string, init!);
  });
  logs = [];
  forwarded.length = 0;
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
  worker = (await import('../src/index.ts')).default;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(
  path: string,
  init: { headers?: Record<string, string>; env?: Record<string, unknown> } = {},
) {
  const response = await worker.fetch(
    new Request(`http://localhost:8787${path}`, { headers: init.headers ?? {} }),
    init.env ?? ENV,
  );
  const text = await response.text();
  for (const secret of [TEST_MASSIVE_KEY, TEST_KEY_ID, TEST_SECRET]) {
    expect(text).not.toContain(secret);
    for (const [, value] of response.headers) expect(value).not.toContain(secret);
  }
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const bars = (tf: string, extra = '') =>
  call(`/api/v1/bars?instrumentId=fut:NQ:2026-12&timeframe=${tf}&session=regular${extra}`);

describe('resolve by asset class', () => {
  test('a futures root resolves to a specific contract with an opaque stream key', async () => {
    const r = await call('/api/v1/instruments/resolve?symbol=nq&assetClass=future');
    expect(r.status).toBe(200);
    expect(r.body.instrument).toMatchObject({
      id: 'fut:NQ:2026-12',
      assetClass: 'future',
      displaySymbol: 'NQZ6',
      quantityUnit: 'contracts',
      contractMultiplier: '20',
      future: { rootSymbol: 'NQ', contractMonth: '2026-12', tickValue: '5' },
    });
    expect(r.body.stream).toEqual({ key: 'futures-delayed' });
  });

  test('CL as a future is crude oil; without assetClass the equity feed resolves it', async () => {
    const fut = await call('/api/v1/instruments/resolve?symbol=CL&assetClass=future');
    expect(fut.body.instrument.displaySymbol).toBe('CLX6');
    const eq = await call('/api/v1/instruments/resolve?symbol=SPY');
    expect(eq.body.instrument.id).toBe('eq:SPY');
    expect(eq.body.stream).toBeNull(); // equities are history only in this build
  });

  test('explicit contract codes; expired and unknown contracts carry a reason', async () => {
    expect(
      (await call('/api/v1/instruments/resolve?symbol=NQH7&assetClass=future')).body.instrument.id,
    ).toBe('fut:NQ:2027-03');
    const expired = await call('/api/v1/instruments/resolve?symbol=NQU6&assetClass=future');
    expect(expired.status).toBe(404);
    expect(expired.body.error).toMatchObject({
      code: 'not_found',
      details: { reason: 'contract_expired' },
    });
    const unknown = await call('/api/v1/instruments/resolve?symbol=ZB&assetClass=future');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.details).toEqual({ reason: 'contract_not_found' });
    const bad = await call('/api/v1/instruments/resolve?symbol=NQ&assetClass=bond');
    expect(bad.body.error.details).toEqual({ field: 'assetClass' });
  });

  test('futures not configured -> 503; equities keep working', async () => {
    const env = { ...ENV, MASSIVE_API_KEY: '' };
    expect(
      (await call('/api/v1/instruments/resolve?symbol=NQ&assetClass=future', { env })).status,
    ).toBe(503);
    expect((await call('/api/v1/instruments/resolve?symbol=SPY', { env })).status).toBe(200);
    expect(logs.join('\n')).toMatch(/futuresData":"not_configured:missing_credentials/);
  });
});

describe('ES through the same futures path', () => {
  test('ES resolves, streams via the futures hub key and builds all six Fume timeframes', async () => {
    const r = await call('/api/v1/instruments/resolve?symbol=ES&assetClass=future');
    expect(r.body.instrument).toMatchObject({
      id: 'fut:ES:2026-12',
      displaySymbol: 'ESZ6',
      exchange: 'XCME',
      contractMultiplier: '50',
      future: { tickValue: '12.5' },
    });
    expect(r.body.stream).toEqual({ key: 'futures-delayed' });
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      const page = await call(
        `/api/v1/bars?instrumentId=fut:ES:2026-12&timeframe=${tf}&limit=${tf === '1d' ? 3 : 20}`,
      );
      expect(page.status, tf).toBe(200);
      expect(page.body.bars.length, tf).toBeGreaterThan(0);
      expect(page.body.meta.feed.delayMs).toBe(600_000);
      expect((page.body.bars as Bar[]).at(-1)!.start).toBeLessThanOrEqual(NOW - 10 * MIN);
    }
    const daily = await call('/api/v1/bars?instrumentId=fut:ES:2026-12&timeframe=1d&limit=2');
    expect((daily.body.bars as Bar[]).at(-1)!.start).toBe(Date.UTC(2026, 8, 29, 22));
  });
});

describe('canonical futures candles (Fume-built from 1-minute bars)', () => {
  const utc = (b: Bar) => new Date(b.start).toISOString().slice(11, 16);

  test('1m: latest = newest delayed minute; meta names a delayed feed', async () => {
    const r = await bars('1m', '&limit=30');
    expect(r.status).toBe(200);
    expect(r.body.meta.feed).toEqual({
      providerId: 'massive',
      feedId: 'futures-delayed',
      consolidated: true,
      delayMs: 600_000,
      displayName: 'CME futures',
    });
    const last = r.body.bars.at(-1) as Bar;
    expect(last.start).toBe(NOW - 10 * MIN);
    expect(r.body.bars).toHaveLength(30);
  });

  test('candle status is judged in DELAYED time: a bucket ended by the wall clock but not by the delayed data stays provisional', async () => {
    // NOW = 17:40Z; delayed data through the 17:30 minute. The 5m bucket 17:30-17:35 has ended
    // by the wall clock but holds only one delayed minute: provisional (it was "final" before).
    const r = await bars('5m', '&limit=3');
    const [prev, last] = (r.body.bars as Bar[]).slice(-2);
    expect([last!.start, last!.status]).toEqual([Date.UTC(2026, 8, 30, 17, 30), 'provisional']);
    expect([prev!.start, prev!.status]).toEqual([Date.UTC(2026, 8, 30, 17, 25), 'final']);
    // 15m bucket 17:15-17:30 ended at 17:30 <= delayed now 17:30 -> final; 1h 17:00 -> provisional.
    const q = (await bars('15m', '&limit=3')).body.bars as Bar[];
    expect(q.find((b) => b.start === Date.UTC(2026, 8, 30, 17, 15))!.status).toBe('final');
    const h = ((await bars('1h', '&limit=2')).body.bars as Bar[]).at(-1)!;
    expect([h.start, h.status]).toEqual([Date.UTC(2026, 8, 30, 17), 'provisional']);
  });

  test('4h buckets are aligned to the 17:00 CT session start, not to UTC clock hours', async () => {
    const r = await bars('4h', '&limit=12');
    const starts = new Set((r.body.bars as Bar[]).map(utc));
    // Session 22:00Z -> buckets 22:00, 02:00, 06:00, 10:00, 14:00, 18:00 (clipped at 21:00).
    expect([...starts].sort()).toEqual(['02:00', '06:00', '10:00', '14:00', '18:00', '22:00']);
    const fri = (r.body.bars as Bar[]).filter((b) => utc(b) === '18:00');
    expect(fri.length).toBeGreaterThan(0);
    // The in-progress (delayed) bucket is provisional; completed ones final.
    expect((r.body.bars as Bar[]).at(-1)!.status).toBe('provisional');
    expect((r.body.bars as Bar[]).at(-2)!.status).toBe('final');
  });

  test('1h buckets start on the session hour grid; 1d candles span the whole Globex session', async () => {
    const h = await bars('1h', '&limit=30');
    expect((h.body.bars as Bar[]).every((b) => b.start % HOUR === 0)).toBe(true);
    const d = await bars('1d', '&limit=3');
    const daily = d.body.bars as Bar[];
    expect(daily.map(utc).every((t) => t === '22:00')).toBe(true); // 17:00 CT (CDT)
    expect(daily.at(-1)!.start).toBe(Date.UTC(2026, 8, 29, 22));
  });

  test('left paging: end = oldest start returns strictly older candles', async () => {
    const first = await bars('15m', '&limit=40');
    const oldest = (first.body.bars as Bar[])[0]!.start;
    const older = await bars('15m', `&limit=40&end=${oldest}`);
    expect(older.status).toBe(200);
    expect((older.body.bars as Bar[]).every((b) => b.start < oldest)).toBe(true);
    expect((older.body.bars as Bar[]).at(-1)!.start).toBe(oldest - 15 * MIN);
    expect(older.body.hasMore).toBe(true);
  });

  test('sessions for a futures id come from the provider schedule', async () => {
    const r = await call(
      `/api/v1/sessions?instrumentId=fut:NQ:2026-12&from=${Date.UTC(2026, 8, 27)}&to=${Date.UTC(2026, 9, 3)}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: { sessionDate: string }) => s.sessionDate)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(r.body.sessions[0].windows).toEqual([
      { start: Date.UTC(2026, 8, 27, 22), end: Date.UTC(2026, 8, 28, 21), kind: 'regular' },
    ]);
  });

  test('malformed and foreign futures ids are rejected', async () => {
    expect(
      (await call('/api/v1/bars?instrumentId=fut:NQ:2026-13&timeframe=1h')).body.error.details,
    ).toEqual({
      field: 'instrumentId',
    });
    expect((await call('/api/v1/bars?instrumentId=fut:ZB:2026-12&timeframe=1h')).status).toBe(404);
  });
});

describe('/api/v1/stream (WebSocket upgrade -> provider/feed-scoped hub)', () => {
  const ws = { Upgrade: 'websocket', Origin: 'http://localhost:5173' };

  test('a valid upgrade is forwarded to the hub named by the key, with the key header set', async () => {
    const r = await call('/api/v1/stream?key=futures-delayed', { headers: ws });
    expect(r.status).toBe(200);
    expect(r.body).toBe('hub:futures-delayed');
    expect(forwarded[0]!.headers.get('X-Fume-Stream-Key')).toBe('futures-delayed');
  });

  test('origin, authentication and validation run first', async () => {
    expect(
      (
        await call('/api/v1/stream?key=futures-delayed', {
          headers: { ...ws, Origin: 'http://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('/api/v1/stream?key=futures-delayed', {
          headers: ws,
          env: { ...ENV, FUME_ENV: 'prod' },
        })
      ).status,
    ).toBe(401);
    expect((await call('/api/v1/stream?key=futures-delayed')).status).toBe(426);
    expect((await call('/api/v1/stream?key=BAD KEY', { headers: ws })).status).toBe(400);
    expect((await call('/api/v1/stream?key=equities', { headers: ws })).status).toBe(404);
    expect(
      (
        await call('/api/v1/stream?key=futures-delayed', {
          headers: ws,
          env: { ...ENV, FEED_HUB: undefined },
        })
      ).status,
    ).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  test('health lists both feeds; the futures feed streams when the hub is bound', async () => {
    const r = await call('/api/v1/health');
    expect(r.body.feeds).toEqual([
      {
        assetClasses: ['equity', 'etf'],
        feedId: 'iex',
        delayMs: 0,
        configured: true,
        streaming: false,
      },
      {
        assetClasses: ['future'],
        feedId: 'futures-delayed',
        delayMs: 600_000,
        configured: true,
        streaming: true,
      },
    ]);
  });
});

test('no credential ever appears in logs', async () => {
  await call('/api/v1/instruments/resolve?symbol=GC&assetClass=future');
  await bars('1h');
  for (const line of logs) {
    expect(line).not.toContain(TEST_MASSIVE_KEY);
    expect(line).not.toContain(TEST_KEY_ID);
  }
  expect(massive.requests.every((r) => !JSON.stringify(r).includes(TEST_MASSIVE_KEY))).toBe(true);
});
