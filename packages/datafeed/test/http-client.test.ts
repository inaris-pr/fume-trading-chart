import { describe, expect, test } from 'vitest';
import type { InstrumentId } from '@fume/core';
import { FumeApiError, FumeHttpClient, type FetchLike } from '../src/api/http-client.ts';

const SPY = 'eq:SPY' as InstrumentId;
const bar = (start: number, extra: Record<string, unknown> = {}) => ({
  start,
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
  volume: 10,
  status: 'final',
  revision: 0,
  ...extra,
});
const meta = {
  instrumentId: 'eq:SPY',
  timeframe: '1h',
  sessionMode: 'regular',
  feed: { providerId: 'x', feedId: 'iex', consolidated: false, delayMs: 0 },
};

function client(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers,
    });
  };
  return { c: new FumeHttpClient(fetch), urls };
}

async function apiError(promise: Promise<unknown>): Promise<FumeApiError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(FumeApiError);
    return e as FumeApiError;
  }
  throw new Error('expected FumeApiError');
}

describe('FumeHttpClient', () => {
  test('only relative /api/v1 URLs; regular session requested explicitly', async () => {
    const { c, urls } = client({
      meta,
      bars: [bar(1000), bar(2000)],
      hasMore: true,
      serverTime: 5,
    });
    const page = await c.getBars({ instrumentId: SPY, timeframe: '1h', limit: 500, end: 3000 });
    expect(page.bars).toHaveLength(2);
    expect(urls).toEqual([
      '/api/v1/bars?instrumentId=eq%3ASPY&timeframe=1h&session=regular&limit=500&end=3000',
    ]);
    const r = client({ sessions: [] });
    await r.c.getSessions(SPY, 1, 2);
    expect(r.urls).toEqual(['/api/v1/sessions?instrumentId=eq%3ASPY&from=1&to=2']);
    const i = client({
      instrument: {
        id: 'eq:SPY',
        displaySymbol: 'SPY',
        currency: 'USD',
        tickRules: [],
        priceFormat: { kind: 'decimal', decimals: 2 },
        session: { timezone: 'America/New_York' },
        tradable: true,
      },
    });
    await i.c.resolveInstrument('SPY');
    expect(i.urls).toEqual(['/api/v1/instruments/resolve?symbol=SPY']);
  });

  test('error envelope -> FumeApiError with code, retryable and Retry-After', async () => {
    const { c } = client(
      { error: { code: 'rate_limited', message: 'slow down', retryable: true } },
      429,
      { 'Retry-After': '12' },
    );
    const e = await apiError(c.resolveInstrument('SPY'));
    expect(e).toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 12_000,
      message: 'slow down',
    });
  });

  test('non-JSON responses and network failures fail clearly', async () => {
    expect(await apiError(client('<html>', 502).c.resolveInstrument('SPY'))).toMatchObject({
      code: 'internal',
      status: 502,
    });
    const down = new FumeHttpClient(async () => {
      throw new TypeError('failed');
    });
    expect(await apiError(down.resolveInstrument('SPY'))).toMatchObject({
      code: 'unavailable',
      status: 0,
    });
  });

  test.each([
    ['bars not ascending', { meta, bars: [bar(2000), bar(1000)], hasMore: false, serverTime: 1 }],
    ['duplicate starts', { meta, bars: [bar(1000), bar(1000)], hasMore: false, serverTime: 1 }],
    [
      'non-finite price',
      { meta, bars: [bar(1000, { close: 'x' })], hasMore: false, serverTime: 1 },
    ],
    ['high < low', { meta, bars: [bar(1000, { high: 0 })], hasMore: false, serverTime: 1 }],
    ['bad status', { meta, bars: [bar(1000, { status: 'done' })], hasMore: false, serverTime: 1 }],
    ['missing hasMore', { meta, bars: [], serverTime: 1 }],
    [
      'meta for another timeframe',
      { meta: { ...meta, timeframe: '4h' }, bars: [], hasMore: false, serverTime: 1 },
    ],
    [
      'meta for another instrument',
      { meta: { ...meta, instrumentId: 'eq:QQQ' }, bars: [], hasMore: false, serverTime: 1 },
    ],
    [
      'bar at or after the exclusive end',
      { meta, bars: [bar(3000)], hasMore: false, serverTime: 1 },
    ],
  ])('malformed bars response is rejected: %s', async (_label, body) => {
    const e = await apiError(
      client(body).c.getBars({ instrumentId: SPY, timeframe: '1h', limit: 10, end: 3000 }),
    );
    expect(e.code).toBe('internal');
    expect(e.message).toMatch(/Malformed/);
  });

  test('malformed sessions and instruments are rejected', async () => {
    const badSessions = {
      sessions: [{ sessionDate: 'x', windows: [{ start: 2, end: 1, kind: 'regular' }] }],
    };
    expect((await apiError(client(badSessions).c.getSessions(SPY, 1, 2))).code).toBe('internal');
    expect(
      (await apiError(client({ instrument: { id: 'eq:SPY' } }).c.resolveInstrument('SPY'))).code,
    ).toBe('internal');
  });
});

describe('embedding configuration', () => {
  const okBody = {
    instrument: {
      id: 'fut:NQ:2026-12',
      displaySymbol: 'NQZ6',
      currency: 'USD',
      tickRules: [],
      session: { timezone: 'America/Chicago' },
      priceFormat: { kind: 'decimal', decimals: 2 },
      tradable: false,
    },
    stream: { key: 'futures-delayed' },
  };

  test('configurable base URL and auth headers on every request (never in the URL)', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const c = new FumeHttpClient({
      baseUrl: 'https://fume.example/api/v1/',
      getAuthHeaders: async () => ({ Authorization: 'Bearer host-token' }),
      fetch: async (url, init) => {
        calls.push({ url, headers: init!.headers as Record<string, string> });
        return new Response(JSON.stringify(okBody), { status: 200 });
      },
    });
    const r = await c.resolveInstrument('NQ', undefined, 'future');
    expect(r).toMatchObject({ instrument: { id: 'fut:NQ:2026-12' }, streamKey: 'futures-delayed' });
    expect(calls[0]!.url).toBe(
      'https://fume.example/api/v1/instruments/resolve?symbol=NQ&assetClass=future',
    );
    expect(calls[0]!.headers).toMatchObject({
      Authorization: 'Bearer host-token',
      Accept: 'application/json',
    });
  });

  test('error details.reason is surfaced as a provider-neutral reason', async () => {
    const c = new FumeHttpClient(async () =>
      Response.json(
        {
          error: {
            code: 'not_found',
            message: 'That futures contract has expired',
            retryable: false,
            details: { reason: 'contract_expired' },
          },
        },
        { status: 404 },
      ),
    );
    const e = await c.resolveInstrument('NQU6', undefined, 'future').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FumeApiError);
    expect(e).toMatchObject({ status: 404, code: 'not_found', reason: 'contract_expired' });
  });
});
