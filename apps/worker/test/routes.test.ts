/**
 * Route tests through the real composition root (src/index.ts) with `fetch` stubbed by the offline
 * FakeAlpaca and a fixed clock. Covers origin policy, local-only authentication, validation, the
 * error envelope and the four market-data routes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Bar, MarketSession } from '@fume/core';
import { FakeAlpaca, TEST_KEY_ID, TEST_SECRET, type FakeAlpacaOptions } from './fake-alpaca.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FRI_OPEN = Date.UTC(2026, 8, 25, 13, 30); // Fri 2026-09-25 09:30 EDT
const SAT = Date.UTC(2026, 8, 26, 16, 0);

const ENV = {
  FUME_ENV: 'local',
  ALPACA_DATA_BASE_URL: 'https://data.alpaca.markets',
  ALPACA_TRADING_BASE_URL: 'https://paper-api.alpaca.markets',
  ALPACA_DATA_FEED: 'iex',
  FUME_ALLOWED_ORIGINS: 'http://localhost:5173',
  ALPACA_API_KEY_ID: TEST_KEY_ID,
  ALPACA_API_SECRET_KEY: TEST_SECRET,
};

let fake: FakeAlpaca;
let logs: string[];
let worker: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

async function boot(options: FakeAlpacaOptions = {}, now = SAT) {
  vi.resetModules(); // fresh isolate-level caches per test
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  fake = new FakeAlpaca({ now, ...options });
  vi.stubGlobal('fetch', fake.fetch);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
  worker = (await import('../src/index.ts')).default;
}

beforeEach(() => boot());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(
  path: string,
  init: { method?: string; origin?: string; env?: Record<string, unknown>; host?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (init.origin) headers.Origin = init.origin;
  const request = new Request(`${init.host ?? 'http://localhost:8787'}${path}`, {
    method: init.method ?? 'GET',
    headers,
  });
  const response = await worker.fetch(request, init.env ?? ENV);
  const text = await response.text();
  // No response may ever carry a credential.
  expect(text).not.toContain(TEST_KEY_ID);
  expect(text).not.toContain(TEST_SECRET);
  for (const [, value] of response.headers) {
    expect(value).not.toContain(TEST_KEY_ID);
    expect(value).not.toContain(TEST_SECRET);
  }
  return { response, status: response.status, body: text ? (JSON.parse(text) as any) : null };
}

const expectError = (r: { status: number; body: any }, status: number, code: string) => {
  expect(r.status).toBe(status);
  expect(Object.keys(r.body)).toEqual(['error']);
  expect(r.body.error.code).toBe(code);
  expect(typeof r.body.error.message).toBe('string');
  expect(typeof r.body.error.retryable).toBe('boolean');
};

const barsQuery = (tf: string, extra = '') =>
  `/api/v1/bars?instrumentId=eq:SPY&timeframe=${tf}&session=regular${extra}`;
const et = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
  });

describe('health', () => {
  test('non-sensitive status only, no upstream call', async () => {
    const r = await call('/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      version: expect.any(String),
      tradingEnvironment: 'paper',
      marketDataFeed: 'iex',
      marketDataConfigured: true,
    });
    expect(fake.requests).toHaveLength(0);
  });

  test('reports an unconfigured provider without saying which value is missing', async () => {
    const r = await call('/api/v1/health', { env: { ...ENV, ALPACA_API_SECRET_KEY: '' } });
    expect(r.body).toMatchObject({ ok: true, marketDataConfigured: false, marketDataFeed: null });
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET|KEY_ID/);
  });
});

describe('local-only authentication (fail closed)', () => {
  test.each([
    ['FUME_ENV missing', { ...ENV, FUME_ENV: undefined }, 'http://localhost:8787'],
    ['FUME_ENV=production', { ...ENV, FUME_ENV: 'production' }, 'http://localhost:8787'],
    ['local mode on a non-loopback host', ENV, 'https://fume.example.com'],
  ])('%s -> 401 unauthorized', async (_label, env, host) => {
    expectError(await call('/api/v1/health', { env, host }), 401, 'unauthorized');
  });

  test('127.0.0.1 is loopback', async () => {
    expect((await call('/api/v1/health', { host: 'http://127.0.0.1:8787' })).status).toBe(200);
  });
});

describe('origin policy / CORS', () => {
  test('approved origin gets its exact origin echoed and Vary: Origin (never *)', async () => {
    const r = await call('/api/v1/health', { origin: 'http://localhost:5173' });
    expect(r.status).toBe(200);
    expect(r.response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(r.response.headers.get('Vary')).toBe('Origin');
  });

  test('rejected origin -> 403 forbidden_origin without CORS headers', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:5174', 'null']) {
      const r = await call('/api/v1/health', { origin });
      expectError(r, 403, 'forbidden_origin');
      expect(r.response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  test('preflight: allowed origin -> 204 with methods; disallowed -> 403', async () => {
    const ok = await call('/api/v1/bars', { method: 'OPTIONS', origin: 'http://localhost:5173' });
    expect(ok.status).toBe(204);
    expect(ok.response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(ok.response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    expectError(
      await call('/api/v1/bars', { method: 'OPTIONS', origin: 'http://evil.example' }),
      403,
      'forbidden_origin',
    );
  });

  test('no Origin header passes the origin step (then authentication applies)', async () => {
    const r = await call('/api/v1/health');
    expect(r.response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(r.response.headers.get('Vary')).toBe('Origin');
  });

  test('the allowlist is exact; wildcard entries allow nothing', async () => {
    const env = { ...ENV, FUME_ALLOWED_ORIGINS: '*, http://localhost:5173/path' };
    expectError(
      await call('/api/v1/health', { env, origin: 'http://localhost:5173' }),
      403,
      'forbidden_origin',
    );
  });
});

describe('routing', () => {
  test('unknown route -> 404 envelope; unsupported method -> 405 envelope', async () => {
    expectError(await call('/api/v1/nope'), 404, 'not_found');
    expectError(await call('/'), 404, 'not_found');
    const post = await call('/api/v1/health', { method: 'POST' });
    expectError(post, 405, 'invalid_request');
    expect(post.response.headers.get('Allow')).toBe('GET, OPTIONS');
  });

  test('responses are JSON and not cached', async () => {
    const r = await call('/api/v1/health');
    expect(r.response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(r.response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/v1/instruments/resolve', () => {
  test('SPY (case-normalized)', async () => {
    const r = await call('/api/v1/instruments/resolve?symbol=spy');
    expect(r.status).toBe(200);
    expect(r.body.instrument).toMatchObject({
      id: 'eq:SPY',
      displaySymbol: 'SPY',
      assetClass: 'equity',
    });
    expect(JSON.stringify(r.body)).not.toMatch(/us_equity|easy_to_borrow|marginable/); // no raw payload
  });

  test('validation and not-found', async () => {
    expectError(await call('/api/v1/instruments/resolve'), 400, 'invalid_request');
    const bad = await call('/api/v1/instruments/resolve?symbol=%24%24%24');
    expectError(bad, 400, 'invalid_request');
    expect(bad.body.error.details).toEqual({ field: 'symbol' });
    expectError(
      await call('/api/v1/instruments/resolve?symbol=TOOLONGSYMBOL'),
      400,
      'invalid_request',
    );
    expectError(await call('/api/v1/instruments/resolve?symbol=NOPE'), 404, 'not_found');
    expectError(await call('/api/v1/instruments/resolve?symbol=OLD'), 404, 'not_found');
  });
});

describe('GET /api/v1/sessions', () => {
  test('ascending MarketSession[] from the calendar', async () => {
    const r = await call(
      `/api/v1/sessions?instrumentId=eq:SPY&from=${Date.UTC(2026, 8, 20)}&to=${Date.UTC(2026, 8, 27)}`,
    );
    expect(r.status).toBe(200);
    const sessions = r.body.sessions as MarketSession[];
    expect(sessions.map((s) => s.sessionDate)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
    expect(sessions[4]!.windows).toEqual([
      { start: FRI_OPEN, end: FRI_OPEN + 6.5 * HOUR, kind: 'regular' },
    ]);
    expect(sessions.every((s) => s.instrumentId === 'eq:SPY')).toBe(true);
  });

  test('validation', async () => {
    const base = '/api/v1/sessions?instrumentId=eq:SPY';
    expectError(await call(`${base}&from=10`), 400, 'invalid_request');
    expectError(await call(`${base}&from=20&to=10`), 400, 'invalid_request');
    expectError(await call(`${base}&from=10&to=10`), 400, 'invalid_request');
    expectError(await call(`${base}&from=0&to=${1200 * 86_400_000}`), 400, 'invalid_request');
    expectError(await call(`${base}&from=-5&to=10`), 400, 'invalid_request');
    expectError(
      await call('/api/v1/sessions?instrumentId=SPY&from=1&to=2'),
      400,
      'invalid_request',
    );
    expectError(await call('/api/v1/sessions?instrumentId=eq:NOPE&from=1&to=2'), 404, 'not_found');
  });
});

describe('GET /api/v1/bars', () => {
  test('1h: session-aligned 09:30 ... 15:30 (short) per regular session; meta, serverTime, hasMore', async () => {
    const r = await call(barsQuery('1h', '&limit=2000'));
    expect(r.status).toBe(200);
    expect(r.body.meta).toEqual({
      instrumentId: 'eq:SPY',
      timeframe: '1h',
      sessionMode: 'regular',
      feed: { providerId: 'alpaca', feedId: 'iex', consolidated: false, delayMs: 0 },
    });
    expect(r.body.serverTime).toBe(SAT);
    expect(r.body.hasMore).toBe(false); // the fake calendar ends before the floor is reached
    const bars = r.body.bars as Bar[];
    expect(bars).toHaveLength(5 * 7);
    expect(bars.slice(0, 7).map((b) => et(b.start))).toEqual([
      '09:30',
      '10:30',
      '11:30',
      '12:30',
      '13:30',
      '14:30',
      '15:30',
    ]);
    expect(bars.every((b) => b.status === 'final')).toBe(true);
  });

  test('4h: two buckets per full session (09:30, 13:30); 1d: one per session', async () => {
    const four = (await call(barsQuery('4h'))).body.bars as Bar[];
    expect(four.map((b) => et(b.start))).toEqual(
      Array.from({ length: 5 }, () => ['09:30', '13:30']).flat(),
    );
    const daily = (await call(barsQuery('1d'))).body.bars as Bar[];
    expect(daily).toHaveLength(5);
    const fri = fake.minutes.filter((m) => m.start >= FRI_OPEN && m.start < FRI_OPEN + 6.5 * HOUR);
    expect(daily[4]).toMatchObject({
      start: FRI_OPEN,
      open: fri[0]!.open,
      close: fri.at(-1)!.close,
      high: Math.max(...fri.map((m) => m.high)),
      low: Math.min(...fri.map((m) => m.low)),
    });
    expect(daily[4]!.volume).toBeCloseTo(
      fri.reduce((n, m) => n + m.volume, 0),
      6,
    );
  });

  test('1m / 5m / 15m honour limit and are ascending with unique starts', async () => {
    for (const [tf, perSession] of [
      ['1m', 390],
      ['5m', 78],
      ['15m', 26],
    ] as const) {
      const bars = (await call(barsQuery(tf, '&limit=100'))).body.bars as Bar[];
      expect(bars, tf).toHaveLength(100);
      expect(new Set(bars.map((b) => b.start)).size).toBe(100);
      for (let i = 1; i < bars.length; i++)
        expect(bars[i]!.start).toBeGreaterThan(bars[i - 1]!.start);
      expect(bars.at(-1)!.start, tf).toBe(FRI_OPEN + 6.5 * HOUR - (6.5 * HOUR) / perSession);
    }
  });

  test('paging backwards with end = oldest start is exclusive, contiguous and duplicate-free', async () => {
    const all = (await call(barsQuery('15m', '&limit=2000'))).body.bars as Bar[];
    const newest = (await call(barsQuery('15m', '&limit=40'))).body;
    const older = (await call(barsQuery('15m', `&limit=40&end=${newest.bars[0].start}`))).body;
    expect(older.bars.at(-1).start).toBeLessThan(newest.bars[0].start);
    expect([...older.bars, ...newest.bars]).toEqual(all.slice(-80));
    expect(older.hasMore).toBe(true);
  });

  test('an in-progress bucket is provisional; nothing after "now" is returned or fabricated', async () => {
    await boot({}, FRI_OPEN + 95 * MIN + 30_000); // Fri 11:05:30 ET
    const bars = (await call(barsQuery('1h'))).body.bars as Bar[];
    const friday = bars.filter((b) => b.start >= FRI_OPEN);
    expect(friday.map((b) => [et(b.start), b.status])).toEqual([
      ['09:30', 'final'],
      ['10:30', 'provisional'],
    ]);
    const lastMinuteStart = FRI_OPEN + 95 * MIN;
    const inside = fake.minutes.filter(
      (m) => m.start >= FRI_OPEN + HOUR && m.start <= lastMinuteStart,
    );
    expect(friday[1]!.close).toBe(inside.at(-1)!.close);
    expect(friday[1]!.volume).toBeCloseTo(
      inside.reduce((n, m) => n + m.volume, 0),
      6,
    );
  });

  test('early close (13:00): short final 1h bucket 12:30-13:00, 4h 09:30-13:00', async () => {
    await boot({ earlyCloses: ['2026-09-25'] });
    const hours = ((await call(barsQuery('1h'))).body.bars as Bar[]).filter(
      (b) => b.start >= FRI_OPEN,
    );
    expect(hours.map((b) => et(b.start))).toEqual(['09:30', '10:30', '11:30', '12:30']);
    const four = ((await call(barsQuery('4h'))).body.bars as Bar[]).filter(
      (b) => b.start >= FRI_OPEN,
    );
    expect(four.map((b) => et(b.start))).toEqual(['09:30']);
    const lastHour = fake.minutes.filter(
      (m) => m.start >= FRI_OPEN + 3 * HOUR && m.start < FRI_OPEN + 3.5 * HOUR,
    );
    expect(hours[3]!.close).toBe(lastHour.at(-1)!.close);
  });

  test('holidays are compressed: no bars for the missing session', async () => {
    await boot({ holidays: ['2026-09-23'] });
    const daily = (await call(barsQuery('1d'))).body.bars as Bar[];
    expect(daily).toHaveLength(4);
  });

  test('validation', async () => {
    expectError(await call('/api/v1/bars?timeframe=1h'), 400, 'invalid_request');
    expectError(await call('/api/v1/bars?instrumentId=eq:SPY'), 400, 'invalid_request');
    expectError(await call(barsQuery('2h')), 400, 'invalid_request');
    const extended = await call('/api/v1/bars?instrumentId=eq:SPY&timeframe=1h&session=extended');
    expectError(extended, 400, 'invalid_request');
    expect(extended.body.error.details).toEqual({ field: 'session' });
    expectError(await call(barsQuery('1h', '&end=abc')), 400, 'invalid_request');
    expectError(await call(barsQuery('1h', '&end=1.5')), 400, 'invalid_request');
    for (const limit of ['0', '2001', 'abc', '-1'])
      expectError(await call(barsQuery('1h', `&limit=${limit}`)), 400, 'invalid_request');
    expectError(
      await call('/api/v1/bars?instrumentId=eq:spy&timeframe=1h'),
      400,
      'invalid_request',
    );
    expectError(await call('/api/v1/bars?instrumentId=eq:NOPE&timeframe=1h'), 404, 'not_found');
    expect(fake.requests.filter((r) => r.url.pathname.endsWith('/bars'))).toHaveLength(0);
  });

  test('before the history floor: empty page, hasMore false, no bar request', async () => {
    const r = await call(barsQuery('1h', `&end=${Date.UTC(2015, 5, 1)}`));
    expect(r.body).toMatchObject({ bars: [], hasMore: false });
  });

  test('provider calls per request are bounded and logged without secrets', async () => {
    await call(barsQuery('1d', '&limit=2000'));
    const entry = JSON.parse(logs.at(-1)!);
    expect(entry).toMatchObject({ route: '/api/v1/bars', status: 200, bars: 5 });
    expect(entry.providerCalls).toBeLessThanOrEqual(16);
    for (const line of logs) {
      expect(line).not.toContain(TEST_KEY_ID);
      expect(line).not.toContain(TEST_SECRET);
      expect(line).not.toMatch(/apca/i);
    }
  });
});

describe('upstream failures use the Fume envelope', () => {
  const resolveOnce = () => call('/api/v1/instruments/resolve?symbol=SPY');

  test('429 -> 429 rate_limited with Retry-After preserved (or defaulted)', async () => {
    fake.nextResponse = {
      status: 429,
      body: { message: 'too many requests' },
      headers: { 'Retry-After': '12' },
    };
    const r = await resolveOnce();
    expectError(r, 429, 'rate_limited');
    expect(r.body.error.retryable).toBe(true);
    expect(r.response.headers.get('Retry-After')).toBe('12');
    fake.nextResponse = { status: 429, body: 'slow down' };
    expect(
      (await call('/api/v1/instruments/resolve?symbol=NVDA')).response.headers.get('Retry-After'),
    ).toBe('60');
  });

  test.each([
    [401, 503, 'unavailable'],
    [500, 503, 'unavailable'],
  ])('upstream %i -> %i %s (no upstream text)', async (upstream, status, code) => {
    fake.nextResponse = { status: upstream, body: { message: 'UPSTREAM-DETAIL' } };
    const r = await resolveOnce();
    expectError(r, status, code);
    expect(JSON.stringify(r.body)).not.toContain('UPSTREAM-DETAIL');
  });

  test('data-API 403 -> insufficient_entitlement', async () => {
    await call('/api/v1/instruments/resolve?symbol=SPY'); // warm the asset cache
    await call(`/api/v1/sessions?instrumentId=eq:SPY&from=${Date.UTC(2026, 8, 1)}&to=${SAT}`);
    const original = fake.fetch;
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) =>
      input.includes('/bars')
        ? Response.json({ message: 'subscription does not permit' }, { status: 403 })
        : original(input, init),
    );
    expectError(await call(barsQuery('1h')), 403, 'insufficient_entitlement');
  });

  test('malformed upstream JSON -> 502 unavailable; unconfigured provider -> 503', async () => {
    fake.nextResponse = { status: 200, body: '{"id":' };
    expectError(await resolveOnce(), 502, 'unavailable');
    expectError(
      await call(barsQuery('1h'), { env: { ...ENV, ALPACA_API_KEY_ID: '' } }),
      503,
      'unavailable',
    );
    expectError(
      await call(barsQuery('1h'), {
        env: { ...ENV, ALPACA_TRADING_BASE_URL: 'https://api.alpaca.markets' },
      }),
      503,
      'unavailable',
    );
    expectError(
      await call(barsQuery('1h'), { env: { ...ENV, ALPACA_DATA_FEED: 'sip' } }),
      503,
      'unavailable',
    );
  });
});
