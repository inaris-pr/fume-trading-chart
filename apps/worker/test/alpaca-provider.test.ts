import { describe, expect, test } from 'vitest';
import type { Instrument } from '@fume/core';
import { ProviderFailure } from '../src/errors.ts';
import { AlpacaHttpClient } from '../src/providers/alpaca/client.ts';
import {
  ALPACA_HISTORY_FLOOR,
  AlpacaMarketDataProvider,
  AlpacaSharedCache,
} from '../src/providers/alpaca/market-data-provider.ts';
import { FakeAlpaca, TEST_KEY_ID, TEST_SECRET } from './fake-alpaca.ts';

const MIN = 60_000;
const after = Date.UTC(2030, 0, 1);

function setup(
  options: ConstructorParameters<typeof FakeAlpaca>[0] = {},
  now = after,
  native = [1, 5, 15],
) {
  const fake = new FakeAlpaca(options);
  const cache = new AlpacaSharedCache();
  const make = () => {
    const client = new AlpacaHttpClient({
      dataBaseUrl: 'https://data.alpaca.markets',
      tradingBaseUrl: 'https://paper-api.alpaca.markets',
      credentials: { keyId: TEST_KEY_ID, secretKey: TEST_SECRET },
      fetch: fake.fetch,
      maxCalls: 30,
    });
    return {
      client,
      provider: new AlpacaMarketDataProvider({
        client,
        cache,
        now: () => now,
        nativeIntervalsMinutes: native,
      }),
    };
  };
  return { fake, cache, make, ...make() };
}

describe('instrument resolution', () => {
  test('resolves SPY through the asset endpoint and caches it', async () => {
    const { fake, provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    expect(spy).toMatchObject({ id: 'eq:SPY', assetClass: 'equity', exchange: 'ARCX' });
    await provider.resolveInstrument('SPY');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url.href).toBe('https://paper-api.alpaca.markets/v2/assets/SPY');
  });

  test('unknown, inactive and non-listed-exchange symbols', async () => {
    const { provider } = setup();
    expect(await provider.resolveInstrument('NOPE')).toBeNull();
    expect(await provider.resolveInstrument('OLD')).toBeNull();
    const otc = await provider.resolveInstrument('OTCX');
    expect(otc).not.toBeNull();
    expect(otc).not.toHaveProperty('exchange');
  });

  test('other upstream failures propagate (not cached as "not found")', async () => {
    const { fake, provider } = setup();
    fake.nextResponse = { status: 500, body: { message: 'boom' } };
    await expect(provider.resolveInstrument('SPY')).rejects.toBeInstanceOf(ProviderFailure);
    expect(await provider.resolveInstrument('SPY')).not.toBeNull();
  });
});

describe('calendar sessions', () => {
  test('holidays and early closes come from the calendar; one upstream call per missing range', async () => {
    const { fake, provider, make } = setup({
      from: '2025-11-24',
      to: '2025-12-02',
      holidays: ['2025-11-27'],
      earlyCloses: ['2025-11-28'],
    });
    const spy = (await provider.resolveInstrument('SPY'))!;
    const sessions = await provider.getSessions(spy, Date.UTC(2025, 10, 24), Date.UTC(2025, 11, 3));
    expect(sessions.map((s) => s.sessionDate)).toEqual([
      '2025-11-24',
      '2025-11-25',
      '2025-11-26',
      '2025-11-28',
      '2025-12-01',
      '2025-12-02',
    ]);
    const friday = sessions.find((s) => s.sessionDate === '2025-11-28')!;
    expect(friday.windows).toEqual([
      {
        start: Date.UTC(2025, 10, 28, 14, 30),
        end: Date.UTC(2025, 10, 28, 18, 0),
        kind: 'regular',
      },
    ]);
    expect(sessions.every((s) => s.instrumentId === spy.id)).toBe(true);
    const calendarCalls = () => fake.requests.filter((r) => r.url.pathname === '/v2/calendar');
    expect(calendarCalls()).toHaveLength(1);
    expect(calendarCalls()[0]!.url.search).toBe('?start=2025-01-01&end=2025-12-31');
    // A second per-request provider reuses the isolate cache for a past year.
    await make().provider.getSessions(spy, Date.UTC(2025, 10, 25), Date.UTC(2025, 10, 26));
    expect(calendarCalls()).toHaveLength(1);
  });

  test('sessions are filtered to the requested range', async () => {
    const { provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    const sessions = await provider.getSessions(
      spy,
      Date.UTC(2026, 8, 23, 12),
      Date.UTC(2026, 8, 24, 12),
    );
    expect(sessions.map((s) => s.sessionDate)).toEqual(['2026-09-23']);
  });
});

describe('base bars', () => {
  test('explicit feed=iex, adjustment=raw, sort=desc, start, inclusive end, timeframe', async () => {
    const { fake, provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    const end = Date.UTC(2026, 8, 25, 14, 0);
    await provider.getBars({
      instrument: spy,
      intervalMinutes: 15,
      start: Date.UTC(2026, 8, 25, 13, 30),
      end,
      limit: 50,
    });
    const q = fake.requests.at(-1)!.url.searchParams;
    expect(fake.requests.at(-1)!.url.pathname).toBe('/v2/stocks/SPY/bars');
    expect(Object.fromEntries(q)).toEqual({
      timeframe: '15Min',
      start: '2026-09-25T13:30:00.000Z',
      end: '2026-09-25T13:59:59.999Z',
      limit: '50',
      adjustment: 'raw',
      feed: 'iex',
      sort: 'desc',
    });
  });

  test('without start, the explicit history floor is sent (no reliance on upstream defaults)', async () => {
    const { fake, provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    await provider.getBars({ instrument: spy, intervalMinutes: 1, end: after, limit: 10 });
    expect(fake.requests.at(-1)!.url.searchParams.get('start')).toBe(
      new Date(ALPACA_HISTORY_FLOOR).toISOString(),
    );
  });

  test('exclusive end: a bar starting exactly at end is not returned', async () => {
    const { provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    const end = Date.UTC(2026, 8, 25, 14, 0);
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 1,
      start: Date.UTC(2026, 8, 25, 13, 30),
      end,
      limit: 1000,
    });
    expect(page.bars.at(-1)!.start).toBe(end - MIN);
    expect(page.bars.every((b) => b.start < end)).toBe(true);
    expect(page.bars).toHaveLength(30);
    expect(page.hasMore).toBe(false);
  });

  test('1m / 5m / 15m bars are ascending, aligned and carry trade count and vwap', async () => {
    const { provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    for (const minutes of [1, 5, 15]) {
      const page = await provider.getBars({
        instrument: spy,
        intervalMinutes: minutes,
        start: Date.UTC(2026, 8, 21),
        end: Date.UTC(2026, 8, 26),
        limit: 10_000,
      });
      expect(page.bars.length, `${minutes}m`).toBe((5 * 390) / minutes);
      for (let i = 1; i < page.bars.length; i++)
        expect(page.bars[i]!.start).toBeGreaterThan(page.bars[i - 1]!.start);
      expect(page.bars.every((b) => b.start % (minutes * MIN) === 0)).toBe(true);
      expect(page.bars[0]).toHaveProperty('tradeCount');
      expect(page.bars[0]).toHaveProperty('vwap');
    }
  });

  test('follows next_page_token across pages (upstream page < requested limit)', async () => {
    const { fake, provider } = setup({ pageCap: 400 });
    const spy = (await provider.resolveInstrument('SPY'))!;
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 1,
      start: Date.UTC(2026, 8, 21),
      end: Date.UTC(2026, 8, 26),
      limit: 1000,
    });
    const barCalls = fake.requests.filter((r) => r.url.pathname.endsWith('/bars'));
    expect(barCalls).toHaveLength(3); // 400 + 400 + 200
    expect(barCalls[1]!.url.searchParams.get('page_token')).not.toBeNull();
    expect(barCalls.map((r) => r.url.searchParams.get('limit'))).toEqual(['1000', '600', '200']);
    expect(page.bars).toHaveLength(1000);
    expect(page.bars.at(-1)!.start).toBe(fake.minutes.at(-1)!.start); // newest kept
    expect(page.hasMore).toBe(true);
    expect(provider.lastBarsDiagnostics.pages).toBe(3);
  });

  test('a single page with no token and fewer bars than the limit is complete', async () => {
    const { fake, provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 15,
      start: Date.UTC(2026, 8, 21),
      end: Date.UTC(2026, 8, 26),
      limit: 5000,
    });
    expect(fake.requests.filter((r) => r.url.pathname.endsWith('/bars'))).toHaveLength(1);
    expect(page.bars).toHaveLength(130);
    expect(page.hasMore).toBe(false);
  });

  test('a repeated page token is rejected instead of looping', async () => {
    const { provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    let calls = 0;
    const client = new AlpacaHttpClient({
      dataBaseUrl: 'https://data.alpaca.markets',
      tradingBaseUrl: 'https://paper-api.alpaca.markets',
      credentials: { keyId: TEST_KEY_ID, secretKey: TEST_SECRET },
      fetch: async () => {
        calls++;
        return Response.json({
          bars: [{ t: '2026-09-25T13:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }],
          next_page_token: 'same',
        });
      },
    });
    const looping = new AlpacaMarketDataProvider({
      client,
      cache: new AlpacaSharedCache(),
      now: () => after,
      nativeIntervalsMinutes: [1],
    });
    await expect(
      looping.getBars({ instrument: spy, intervalMinutes: 1, end: after, limit: 100 }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(calls).toBe(2);
  });

  test('page count per call is bounded', async () => {
    const { fake, provider } = setup({ pageCap: 10 });
    const spy = (await provider.resolveInstrument('SPY'))!;
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 1,
      start: Date.UTC(2026, 8, 21),
      end: Date.UTC(2026, 8, 26),
      limit: 10_000,
    });
    expect(fake.requests.filter((r) => r.url.pathname.endsWith('/bars'))).toHaveLength(10);
    expect(page.bars).toHaveLength(100);
    expect(page.hasMore).toBe(true);
  });

  test('IEX gaps stay gaps (no synthetic bars)', async () => {
    const gap = Date.UTC(2026, 8, 25, 14, 0);
    const { provider } = setup({ gaps: [gap, gap + MIN] });
    const spy = (await provider.resolveInstrument('SPY'))!;
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 1,
      start: Date.UTC(2026, 8, 25, 13, 30),
      end: Date.UTC(2026, 8, 25, 14, 30),
      limit: 100,
    });
    expect(page.bars).toHaveLength(58);
    expect(page.bars.some((b) => b.start === gap || b.start === gap + MIN)).toBe(false);
  });

  test('the in-progress interval is provisional, completed ones final', async () => {
    const now = Date.UTC(2026, 8, 25, 13, 30) + 7.5 * MIN; // 09:37:30 ET
    const { provider } = setup({}, now);
    const spy = (await provider.resolveInstrument('SPY'))!;
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 5,
      start: Date.UTC(2026, 8, 25, 13, 30),
      end: now + 1,
      limit: 10,
    });
    expect(page.bars.map((b) => b.status)).toEqual(['final', 'provisional']);
  });

  test('an unverified native interval is refused', async () => {
    const { provider } = setup({}, after, [1]);
    const spy = (await provider.resolveInstrument('SPY'))!;
    await expect(
      provider.getBars({ instrument: spy, intervalMinutes: 15, end: after, limit: 1 }),
    ).rejects.toMatchObject({ code: 'internal' });
  });

  test('an instrument from another provider is refused', async () => {
    const { provider } = setup();
    const spy = (await provider.resolveInstrument('SPY'))!;
    const foreign: Instrument = { ...spy, marketDataRef: { providerId: 'replay', symbol: 'SPY' } };
    await expect(
      provider.getBars({ instrument: foreign, intervalMinutes: 1, end: after, limit: 1 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('feed info is IEX, not consolidated', () => {
    expect(setup().provider.feed).toEqual({
      providerId: 'alpaca',
      feedId: 'iex',
      consolidated: false,
      delayMs: 0,
    });
  });
});
