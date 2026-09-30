import { describe, expect, test } from 'vitest';
import type { TimeframeId } from '@fume/core';
import { loadCanonicalPage } from '../src/canonical-history.ts';
import { AlpacaHttpClient } from '../src/providers/alpaca/client.ts';
import {
  ALPACA_HISTORY_FLOOR,
  AlpacaMarketDataProvider,
  AlpacaSharedCache,
} from '../src/providers/alpaca/market-data-provider.ts';
import { FakeAlpaca, TEST_KEY_ID, TEST_SECRET } from './fake-alpaca.ts';

const SAT = Date.UTC(2026, 8, 26, 16, 0);
const BASE = { earlyCloses: ['2026-09-24'], gaps: [Date.UTC(2026, 8, 22, 15, 7)] };

async function page(
  timeframe: TimeframeId,
  native: number[],
  limit = 2000,
  end?: number,
  fake = new FakeAlpaca(BASE),
) {
  const client = new AlpacaHttpClient({
    dataBaseUrl: 'https://data.alpaca.markets',
    tradingBaseUrl: 'https://paper-api.alpaca.markets',
    credentials: { keyId: TEST_KEY_ID, secretKey: TEST_SECRET },
    fetch: fake.fetch,
    maxCalls: 16,
  });
  const provider = new AlpacaMarketDataProvider({
    client,
    cache: new AlpacaSharedCache(),
    now: () => SAT,
    nativeIntervalsMinutes: native,
  });
  const instrument = (await provider.resolveInstrument('SPY'))!;
  const result = await loadCanonicalPage({
    provider,
    instrument,
    timeframe,
    mode: 'regular',
    ...(end !== undefined ? { end } : {}),
    limit,
    now: SAT,
    historyFloor: ALPACA_HISTORY_FLOOR,
  });
  return { ...result, calls: client.calls, fake };
}

describe('canonical page planning', () => {
  test.each([
    ['1m', 1],
    ['5m', 5],
    ['15m', 15],
    ['1h', 15],
    ['4h', 15],
    ['1d', 15],
  ] as const)(
    '%s uses the coarsest nesting base (%i min) and equals the 1m-only result',
    async (tf, expected) => {
      const coarse = await page(tf, [1, 5, 15]);
      const fine = await page(tf, [1]);
      expect(coarse.diagnostics.baseIntervalMinutes).toBe(expected);
      expect(fine.diagnostics.baseIntervalMinutes).toBe(1);
      expect(coarse.bars.length).toBeGreaterThan(0);
      // OHLC and volume identical (volume summed in a different order: allow float noise only).
      expect(coarse.bars.map(({ volume: _v, vwap: _w, tradeCount: _n, ...rest }) => rest)).toEqual(
        fine.bars.map(({ volume: _v, vwap: _w, tradeCount: _n, ...rest }) => rest),
      );
      coarse.bars.forEach((b, i) => expect(b.volume).toBeCloseTo(fine.bars[i]!.volume, 6));
    },
  );

  test('the number of base bars follows the base interval (fewer provider bars for 1h)', async () => {
    const coarse = await page('1h', [1, 5, 15]);
    const fine = await page('1h', [1]);
    expect(coarse.diagnostics.baseBars * 15).toBeLessThanOrEqual(
      fine.diagnostics.baseBars + 15 * 5,
    );
  });

  test('limit selects only the sessions needed (newest first) and pages cleanly', async () => {
    const newest = await page('1h', [1, 5, 15], 10);
    expect(newest.bars).toHaveLength(10);
    expect(newest.diagnostics.sessions).toBe(2);
    expect(newest.hasMore).toBe(true);
    const older = await page('1h', [1, 5, 15], 10, newest.bars[0]!.start);
    expect(older.bars.at(-1)!.start).toBeLessThan(newest.bars[0]!.start);
    const all = await page('1h', [1, 5, 15], 2000);
    expect([...older.bars, ...newest.bars]).toEqual(all.bars.slice(-20));
  });

  test('provider calls stay bounded (asset + calendar + bar pages)', async () => {
    const r = await page('1m', [1, 5, 15], 2000);
    expect(r.calls).toBeLessThanOrEqual(5);
  });

  test('a genuine IEX gap stays a gap in 1m and is folded (not fabricated) in 1h', async () => {
    const gap = Date.UTC(2026, 8, 22, 15, 7);
    const minutes = await page('1m', [1], 2000);
    expect(minutes.bars.some((b) => b.start === gap)).toBe(false);
    expect(minutes.bars.some((b) => b.start === gap - 60_000)).toBe(true);
  });

  test('pre/post-market base bars are dropped and never shift or truncate regular candles', async () => {
    const withExt = () => new FakeAlpaca({ ...BASE, extendedMinutes: 45 });
    for (const tf of ['1h', '4h', '1d'] as const) {
      const ext = await page(tf, [1, 5, 15], 2000, undefined, withExt());
      const plain = await page(tf, [1, 5, 15], 2000);
      expect(ext.bars, tf).toEqual(plain.bars);
      expect(ext.diagnostics.droppedOutsideSession).toBeGreaterThan(0);
    }
  });

  test('a truncated base fetch (page cap) never returns a partial candle', async () => {
    // Tiny upstream pages + pre/post-market bars: the page cap stops the newest-first fetch
    // part-way through older sessions, like the real IEX data did.
    const capped = () => new FakeAlpaca({ ...BASE, extendedMinutes: 45, pageCap: 8 });
    const reference = await page('1d', [1, 5, 15], 2000);
    for (const tf of ['4h', '1d'] as const) {
      const full = tf === '1d' ? reference : await page(tf, [1, 5, 15], 2000);
      const cut = await page(tf, [1, 5, 15], 2000, undefined, capped());
      expect(cut.diagnostics.truncated, tf).toBe(true);
      expect(cut.hasMore, tf).toBe(true);
      expect(cut.bars.length, tf).toBeGreaterThan(0);
      expect(cut.bars.length, tf).toBeLessThan(full.bars.length);
      // Every returned candle is complete: identical to the untruncated result's candle.
      const byStart = new Map(full.bars.map((b) => [b.start, b]));
      for (const b of cut.bars) expect(b, `${tf} ${b.start}`).toEqual(byStart.get(b.start));
    }
  });
});
