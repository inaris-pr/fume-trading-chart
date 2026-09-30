/**
 * Adapter and canonical-candle tests driven by REAL, sanitized Alpaca IEX response bodies recorded
 * by spike S1 (scripts/s1-verify.ts): SPY, feed=iex, adjustment=raw, completed session
 * 2026-09-29 plus the 2025-11-28 early close. Offline and deterministic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildCanonicalBars,
  canonicalBucketEnd,
  type Bar,
  type InstrumentId,
  type MarketSession,
  type TimeframeId,
} from '@fume/core';
import { ProviderFailure } from '../src/errors.ts';
import { AlpacaHttpClient, type FetchLike } from '../src/providers/alpaca/client.ts';
import {
  ALPACA_NATIVE_INTERVALS,
  AlpacaMarketDataProvider,
  AlpacaSharedCache,
} from '../src/providers/alpaca/market-data-provider.ts';
import {
  normalizeAsset,
  normalizeBars,
  normalizeCalendar,
  parseBarsPage,
} from '../src/providers/alpaca/normalize.ts';
import { TEST_KEY_ID, TEST_SECRET } from './fake-alpaca.ts';

const dir = join(import.meta.dirname, 'fixtures', 'alpaca');
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const MIN = 60_000;
const LATER = Date.UTC(2030, 0, 1);
const ID = 'eq:SPY' as InstrumentId;
const DAY = '2026-09-29';
const EARLY = '2025-11-28';

const bars = (file: string, minutes: number) =>
  normalizeBars(parseBarsPage(load(`recorded/${file}`)).bars, minutes * MIN, LATER).bars;
const b1 = bars(`bars-spy-1min-${DAY}.json`, 1);
const b5 = bars(`bars-spy-5min-${DAY}.json`, 5);
const b15 = bars(`bars-spy-15min-${DAY}.json`, 15);
const e1 = bars(`bars-spy-1min-${EARLY}.json`, 1);
const e15 = bars(`bars-spy-15min-${EARLY}.json`, 15);

const recent = normalizeCalendar(load('recorded/calendar-recent.json'), ID);
const earlyCalendar = normalizeCalendar(load('recorded/calendar-early-close-2025-11.json'), ID);
const session = recent.find((s) => s.sessionDate === DAY)!;
const earlySession = earlyCalendar.find((s) => s.sessionDate === EARLY)!;

const canon = (base: readonly Bar[], minutes: number, tf: TimeframeId, s: MarketSession) =>
  buildCanonicalBars({
    baseBars: base,
    baseIntervalMinutes: minutes,
    sessions: [s],
    timeframe: tf,
    mode: 'regular',
    asOf: LATER,
  }).bars;
const ny = (t: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);

describe('S1 recorded session (SPY IEX 2026-09-29)', () => {
  test('bar counts, ascending order, epoch alignment, all inside the regular session', () => {
    expect([b1.length, b5.length, b15.length]).toEqual([390, 78, 26]);
    const [open, close] = [session.windows[0]!.start, session.windows[0]!.end];
    for (const [series, size] of [
      [b1, 1],
      [b5, 5],
      [b15, 15],
    ] as const) {
      expect(series.every((b) => b.start % (size * MIN) === 0)).toBe(true);
      expect(series.every((b) => b.start >= open && b.start < close)).toBe(true);
      for (let i = 1; i < series.length; i++)
        expect(series[i]!.start).toBeGreaterThan(series[i - 1]!.start);
      expect(series.every((b) => b.tradeCount !== undefined && b.vwap !== undefined)).toBe(true);
    }
    expect(b1[0]!.start).toBe(open);
  });

  test('the only native intervals declared are the S1-verified ones', () => {
    expect([...ALPACA_NATIVE_INTERVALS]).toEqual([1, 5, 15]);
  });

  test('canonical 1m equals the base data', () => {
    const minutes = canon(b1, 1, '1m', session);
    expect(minutes.map(({ vwap: _, ...b }) => b)).toEqual(b1.map(({ vwap: _, ...b }) => b));
    minutes.forEach((b, i) => expect(b.vwap).toBeCloseTo(b1[i]!.vwap!, 9));
  });

  test('canonical 5m / 15m from 1Min equal the native 5Min / 15Min bars (OHLC, volume, trades)', () => {
    const strip = (b: Bar) => ({ ...b, vwap: undefined });
    expect(canon(b1, 1, '5m', session).map(strip)).toEqual(canon(b5, 5, '5m', session).map(strip));
    expect(canon(b1, 1, '15m', session).map(strip)).toEqual(
      canon(b15, 15, '15m', session).map(strip),
    );
    expect(canon(b5, 5, '5m', session).map(strip)).toEqual(b5.map(strip));
  });

  test('1h: starts 09:30 ... 15:30, last bucket short (15:30-16:00); identical from 1Min and 15Min', () => {
    const fromMinutes = canon(b1, 1, '1h', session);
    const fromFifteen = canon(b15, 15, '1h', session);
    expect(fromFifteen.map((b) => ny(b.start))).toEqual([
      '09:30',
      '10:30',
      '11:30',
      '12:30',
      '13:30',
      '14:30',
      '15:30',
    ]);
    const lastEnd = canonicalBucketEnd(fromFifteen.at(-1)!.start, '1h', [session], 'regular')!;
    expect(ny(lastEnd)).toBe('16:00');
    expect(lastEnd - fromFifteen.at(-1)!.start).toBe(30 * MIN);
    expect(fromFifteen.map(({ vwap: _, ...b }) => b)).toEqual(
      fromMinutes.map(({ vwap: _, ...b }) => b),
    );
  });

  test('4h: 09:30 and 13:30, the second ending at 16:00; identical from 1Min and 15Min', () => {
    const four = canon(b15, 15, '4h', session);
    expect(four.map((b) => ny(b.start))).toEqual(['09:30', '13:30']);
    expect(ny(canonicalBucketEnd(four[1]!.start, '4h', [session], 'regular')!)).toBe('16:00');
    expect(four.map(({ vwap: _, ...b }) => b)).toEqual(
      canon(b1, 1, '4h', session).map(({ vwap: _, ...b }) => b),
    );
  });

  test('1d: one RTH session candle equal to the fold of all 390 minutes', () => {
    const [daily, ...rest] = canon(b15, 15, '1d', session);
    expect(rest).toEqual([]);
    expect(daily).toMatchObject({
      start: session.windows[0]!.start,
      open: b1[0]!.open,
      close: b1.at(-1)!.close,
      high: Math.max(...b1.map((b) => b.high)),
      low: Math.min(...b1.map((b) => b.low)),
      volume: b1.reduce((n, b) => n + b.volume, 0),
      tradeCount: b1.reduce((n, b) => n + (b.tradeCount ?? 0), 0),
    });
    expect(canon(b1, 1, '1d', session)[0]!.volume).toBe(daily!.volume);
  });
});

describe('S1 recorded early close (SPY IEX 2025-11-28, close 13:00)', () => {
  test('calendar: 13:00 close; clipped 1h (12:30-13:00) and 4h (09:30-13:00); 1Min == 15Min', () => {
    expect(ny(earlySession.windows[0]!.end)).toBe('13:00');
    const hours = canon(e15, 15, '1h', earlySession);
    expect(hours.map((b) => ny(b.start))).toEqual(['09:30', '10:30', '11:30', '12:30']);
    expect(ny(canonicalBucketEnd(hours[3]!.start, '1h', [earlySession], 'regular')!)).toBe('13:00');
    const four = canon(e15, 15, '4h', earlySession);
    expect(four.map((b) => ny(b.start))).toEqual(['09:30']);
    expect(ny(canonicalBucketEnd(four[0]!.start, '4h', [earlySession], 'regular')!)).toBe('13:00');
    for (const tf of ['1h', '4h', '1d'] as const) {
      expect(
        canon(e15, 15, tf, earlySession).map(({ vwap: _, ...b }) => b),
        tf,
      ).toEqual(canon(e1, 1, tf, earlySession).map(({ vwap: _, ...b }) => b));
    }
  });
});

describe('S1 recorded calendar', () => {
  test('weekends and the Thanksgiving holiday are absent; early closes present; ascending', () => {
    const dates = earlyCalendar.map((s) => s.sessionDate);
    expect(dates).not.toContain('2025-11-27');
    expect(dates).not.toContain('2025-11-29');
    expect(dates).not.toContain('2025-12-25');
    expect([...dates].sort()).toEqual(dates);
    const early = earlyCalendar
      .filter((s) => ny(s.windows[0]!.end) !== '16:00')
      .map((s) => s.sessionDate);
    expect(early).toEqual(['2025-11-28', '2025-12-24']);
    for (const s of recent) {
      const weekday = new Date(`${s.sessionDate}T12:00:00Z`).getUTCDay();
      expect(weekday, s.sessionDate).not.toBe(0);
      expect(weekday, s.sessionDate).not.toBe(6);
    }
  });

  test('DST-correct UTC: 09:30 is 13:30Z in September (EDT) and 14:30Z in November (EST)', () => {
    expect(new Date(session.windows[0]!.start).toISOString().slice(11, 16)).toBe('13:30');
    expect(new Date(earlySession.windows[0]!.start).toISOString().slice(11, 16)).toBe('14:30');
  });
});

describe('S1 recorded asset', () => {
  test('SPY normalizes to a provider-neutral equity (no ETF heuristic), ARCA -> ARCX', () => {
    const spy = normalizeAsset(load('recorded/asset-spy.json'), 'SPY')!;
    expect(spy).toMatchObject({
      id: 'eq:SPY',
      assetClass: 'equity',
      exchange: 'ARCX',
      tradable: true,
      shortable: true,
      currency: 'USD',
      quantityUnit: 'shares',
      contractMultiplier: '1',
    });
    expect(spy.description).toMatch(/SPDR/);
    expect(JSON.stringify(spy)).not.toMatch(/margin|borrow|attributes|b28f4066/);
  });
});

/** Serves recorded bodies by request, like the real API would. */
function recordedFetch(
  route: (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const urls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    urls.push(url);
    const { status = 200, body, headers = {} } = route(url);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const client = new AlpacaHttpClient({
    dataBaseUrl: 'https://data.alpaca.markets',
    tradingBaseUrl: 'https://paper-api.alpaca.markets',
    credentials: { keyId: TEST_KEY_ID, secretKey: TEST_SECRET },
    fetch,
  });
  return {
    urls,
    provider: new AlpacaMarketDataProvider({
      client,
      cache: new AlpacaSharedCache(),
      now: () => LATER,
    }),
  };
}

describe('S1 recorded pagination', () => {
  test('page 1 (limit 200, next_page_token) + page 2 (the remaining 190) merge into the full session', async () => {
    const page1 = load(`recorded/bars-spy-1min-page1-limit200-${DAY}.json`) as {
      next_page_token: string;
    };
    const page2 = load(`recorded/bars-spy-1min-page2-limit200-${DAY}.json`) as {
      next_page_token: string | null;
    };
    const { urls, provider } = recordedFetch((url) => {
      if (url.pathname.startsWith('/v2/assets/')) return { body: load('recorded/asset-spy.json') };
      const token = url.searchParams.get('page_token');
      if (!token) return { body: { ...page1 } };
      expect(token).toBe(page1.next_page_token);
      return { body: page2 };
    });
    const spy = (await provider.resolveInstrument('SPY'))!;
    const page = await provider.getBars({
      instrument: spy,
      intervalMinutes: 1,
      start: session.windows[0]!.start,
      end: session.windows[0]!.end,
      limit: 400,
    });
    expect(page2.next_page_token).toBeNull();
    expect(page.bars).toHaveLength(390);
    expect(new Set(page.bars.map((b) => b.start)).size).toBe(390);
    expect(page.bars.map((b) => b.start)).toEqual(b1.map((b) => b.start));
    expect(page.hasMore).toBe(false);
    expect(urls.filter((u) => u.pathname.endsWith('/bars'))).toHaveLength(2);
  });

  test('sort=desc page (newest first) normalizes to ascending, ending at the last minute', () => {
    const desc = bars(`bars-spy-1min-desc-limit5-${DAY}.json`, 1);
    expect(desc.map((b) => b.start)).toEqual(b1.slice(-5).map((b) => b.start));
  });
});

describe('recorded (real) and synthetic error bodies map to Fume errors', () => {
  test.each([
    ['recorded/error-400-bars.json', 'data', 'invalid_request'],
    ['recorded/error-403-recent-sip.json', 'data', 'insufficient_entitlement'],
    ['recorded/error-404-asset.json', 'trading', 'not_found'],
    ['synthetic/error-401.json', 'data', 'unauthorized'],
    ['synthetic/error-429.json', 'data', 'rate_limited'],
    ['synthetic/error-500.json', 'data', 'unavailable'],
  ] as const)('%s -> %s', async (file, api, code) => {
    const fixture = load(file) as {
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    };
    const client = new AlpacaHttpClient({
      dataBaseUrl: 'https://data.alpaca.markets',
      tradingBaseUrl: 'https://paper-api.alpaca.markets',
      credentials: { keyId: TEST_KEY_ID, secretKey: TEST_SECRET },
      fetch: async () =>
        new Response(JSON.stringify(fixture.body), {
          status: fixture.status,
          headers: fixture.headers ?? {},
        }),
    });
    try {
      await client.getJson(api, 'x');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailure);
      expect((error as ProviderFailure).code).toBe(code);
      if (code === 'rate_limited') expect((error as ProviderFailure).retryAfterMs).toBe(30_000);
    }
  });
});
