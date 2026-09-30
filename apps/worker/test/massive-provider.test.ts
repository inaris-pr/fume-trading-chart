/**
 * MassiveFuturesMarketDataProvider against the offline FakeMassive: root -> contract resolution
 * and recommendation, explicit/expired contracts, instrument metadata, 1-minute bars with cursor
 * paging, sessions with caching, and error mapping. No live data.
 */
import { describe, expect, test } from 'vitest';
import type { Instrument } from '@fume/core';
import { ProviderFailure } from '../src/errors.ts';
import { MassiveHttpClient } from '../src/providers/massive/client.ts';
import {
  futuresInstrumentId,
  MassiveFuturesMarketDataProvider,
  MassiveSharedCache,
  pickRecommended,
} from '../src/providers/massive/market-data-provider.ts';
import { FakeMassive, TEST_MASSIVE_KEY, type FakeMassiveOptions } from './fake-massive.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 30, 17, 40); // Wed 12:40 CT, Globex open

function setup(options: Partial<FakeMassiveOptions> = {}, key = TEST_MASSIVE_KEY) {
  const fake = new FakeMassive({ now: NOW, ...options });
  const client = new MassiveHttpClient({
    baseUrl: 'https://api.massive.com',
    apiKey: key,
    fetch: fake.fetch,
    maxCalls: 40,
  });
  const provider = new MassiveFuturesMarketDataProvider({
    client,
    cache: new MassiveSharedCache(),
    now: () => NOW,
  });
  return { fake, client, provider };
}

describe('root -> contract resolution (reference data, not hard-coded)', () => {
  test('NQ resolves to the highest-volume nearby contract as a specific-contract instrument', async () => {
    const { provider } = setup();
    const nq = await provider.resolveInstrument('NQ');
    expect(nq).toMatchObject({
      id: 'fut:NQ:2026-12',
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
      tradable: false,
      future: { rootSymbol: 'NQ', contractMonth: '2026-12', tickValue: '5' },
      marketDataRef: { providerId: 'massive', symbol: 'NQZ6' },
    });
    expect(nq!.session.timezone).toBe('America/Chicago');
    expect(nq!.brokerageRef).toBeUndefined();
    expect(provider.lastRecommendation).toMatchObject({ method: 'volume', ticker: 'NQZ6' });
  });

  test('GC: the active month (GCZ6) wins over the nearer serial month (GCV6)', async () => {
    const { provider } = setup();
    const gc = await provider.resolveInstrument('GC');
    expect(gc).toMatchObject({ displaySymbol: 'GCZ6', contractMultiplier: '100' });
    expect(gc!.future).toMatchObject({ tickValue: '10' });
    expect(provider.lastRecommendation!.candidates).toEqual(['GCV6', 'GCX6', 'GCZ6', 'GCF7']);
  });

  test('all six required roots resolve with contract metadata from the provider', async () => {
    const { provider } = setup();
    const got: Record<string, Partial<Instrument>> = {};
    for (const root of ['ES', 'NQ', 'YM', 'GC', 'SI', 'CL']) {
      const i = (await provider.resolveInstrument(root))!;
      got[root] = {
        displaySymbol: i.displaySymbol,
        contractMultiplier: i.contractMultiplier,
        exchange: i.exchange!,
      };
      expect(i.future!.tickValue).toBe(
        { ES: '12.5', GC: '10', SI: '25', CL: '10', NQ: '5', YM: '5' }[root],
      );
    }
    expect(got).toEqual({
      ES: { displaySymbol: 'ESZ6', contractMultiplier: '50', exchange: 'XCME' },
      GC: { displaySymbol: 'GCZ6', contractMultiplier: '100', exchange: 'XCEC' },
      SI: { displaySymbol: 'SIZ6', contractMultiplier: '5000', exchange: 'XCEC' },
      CL: { displaySymbol: 'CLX6', contractMultiplier: '1000', exchange: 'XNYM' },
      NQ: { displaySymbol: 'NQZ6', contractMultiplier: '20', exchange: 'XCME' },
      YM: { displaySymbol: 'YMZ6', contractMultiplier: '5', exchange: 'XCBT' },
    });
  });

  test('snapshot unavailable -> nearest non-expired contract (never a guess about volume)', async () => {
    const { provider } = setup({ snapshotDown: true });
    const gc = await provider.resolveInstrument('GC');
    expect(gc!.displaySymbol).toBe('GCV6');
    expect(provider.lastRecommendation).toMatchObject({ method: 'nearest' });
  });

  test('recommendation rule: needs volume AND a recent trade; ties to nearest by expiry order', () => {
    const rec = (t: string, last: string) => ({
      ticker: t,
      root: 'NQ',
      contractMonth: '2026-12',
      firstTradeDate: null,
      lastTradeDate: last,
      settlementDate: null,
      tradeTickSize: 0.25,
      tradingVenue: null,
    });
    const cands = [rec('A', '2026-12-18'), rec('B', '2027-03-19'), rec('C', '2027-06-17')];
    const fresh = NOW - MIN;
    expect(
      pickRecommended(
        cands,
        new Map([
          ['A', { volume: 5, lastTradeMs: fresh }],
          ['B', { volume: 9, lastTradeMs: fresh }],
        ]),
        NOW,
      ),
    ).toEqual({ ticker: 'B', byVolume: true });
    // B has more volume but no recent trade -> A.
    expect(
      pickRecommended(
        cands,
        new Map([
          ['A', { volume: 5, lastTradeMs: fresh }],
          ['B', { volume: 9, lastTradeMs: null }],
        ]),
        NOW,
      ),
    ).toEqual({ ticker: 'A', byVolume: true });
    expect(pickRecommended(cands, new Map(), NOW)).toEqual({ ticker: 'A', byVolume: false });
  });

  test('recommendation and contracts are cached (resolving again makes no upstream calls)', async () => {
    const { provider, fake } = setup();
    await provider.resolveInstrument('NQ');
    const calls = fake.requests.length;
    await provider.resolveInstrument('NQ');
    expect(fake.requests.length).toBe(calls);
  });
});

describe('ES (E-mini S&P 500)', () => {
  test('ES resolves to the recommended specific contract with CME metadata', async () => {
    const { provider } = setup();
    const es = await provider.resolveInstrument('ES');
    expect(es).toMatchObject({
      id: 'fut:ES:2026-12',
      assetClass: 'future',
      displaySymbol: 'ESZ6',
      description: 'E-mini S&P 500 Futures · Dec 2026',
      exchange: 'XCME',
      tickRules: [{ fromPrice: '0', tickSize: '0.25' }],
      priceFormat: { kind: 'decimal', decimals: 2 },
      quantityUnit: 'contracts',
      contractMultiplier: '50',
      future: { rootSymbol: 'ES', contractMonth: '2026-12', tickValue: '12.5' },
      marketDataRef: { providerId: 'massive', symbol: 'ESZ6' },
    });
    expect(new Date(es!.future!.expiration).toISOString().slice(0, 10)).toBe('2026-12-18');
    expect(provider.lastRecommendation).toMatchObject({ method: 'volume', ticker: 'ESZ6' });
  });

  test('explicit ES contracts; an expired one carries contract_expired; 1m bars load', async () => {
    const { provider } = setup();
    expect((await provider.resolveInstrument('ESH7'))!.id).toBe('fut:ES:2027-03');
    await expect(provider.resolveInstrument('ESU6')).rejects.toMatchObject({
      reason: 'contract_expired',
    });
    const es = (await provider.resolveInstrument('ES'))!;
    const page = await provider.getBars({
      instrument: es,
      intervalMinutes: 1,
      end: NOW + 1,
      limit: 20,
    });
    expect(page.bars).toHaveLength(20);
    expect(page.bars.at(-1)!.start).toBe(NOW - 10 * MIN);
  });
});

describe('explicit contracts and ids', () => {
  test('a contract code resolves to that contract; the id round-trips through getInstrument', async () => {
    const { provider } = setup();
    const h7 = await provider.resolveInstrument('NQH7');
    expect(h7).toMatchObject({ id: 'fut:NQ:2027-03', displaySymbol: 'NQH7' });
    const again = await provider.getInstrument(futuresInstrumentId('NQ', '2027-03'));
    expect(again).toEqual(h7);
  });

  test('an expired contract code -> not_found with reason contract_expired', async () => {
    const { provider } = setup();
    await expect(provider.resolveInstrument('NQU6')).rejects.toMatchObject({
      code: 'not_found',
      reason: 'contract_expired',
    });
    // Its id stays loadable for history.
    expect(await provider.getInstrument(futuresInstrumentId('NQ', '2026-09'))).toMatchObject({
      displaySymbol: 'NQU6',
    });
  });

  test('unknown roots, unknown contracts and foreign ids resolve to null', async () => {
    const { provider } = setup();
    expect(await provider.resolveInstrument('ZB')).toBeNull();
    expect(await provider.resolveInstrument('NQF9')).toBeNull();
    expect(await provider.resolveInstrument('SPY')).toBeNull();
    expect(await provider.getInstrument('eq:SPY' as never)).toBeNull();
    expect(await provider.getInstrument('fut:ZB:2026-12' as never)).toBeNull();
  });
});

describe('1-minute bars', () => {
  test('newest `limit` bars in [start, end), ascending, following next_url cursors', async () => {
    const { provider, fake } = setup({ aggsPageSize: 100 });
    const nq = (await provider.resolveInstrument('NQ'))!;
    const end = Date.UTC(2026, 8, 30, 17, 0);
    const page = await provider.getBars({ instrument: nq, intervalMinutes: 1, end, limit: 250 });
    expect(page.bars).toHaveLength(250);
    expect(page.bars.at(-1)!.start).toBe(end - MIN);
    expect(page.bars.every((b, i) => i === 0 || b.start > page.bars[i - 1]!.start)).toBe(true);
    expect(page.hasMore).toBe(true);
    const aggCalls = fake.requests.filter((r) => r.path.startsWith('/futures/v1/aggs/'));
    expect(aggCalls.length).toBe(3); // 100 + 100 + 50
    expect(aggCalls[0]!.query).toMatchObject({ resolution: '1min', sort: 'window_start.desc' });
    // The key is never in a URL, including cursors.
    expect(fake.requests.every((r) => !JSON.stringify(r.query).includes(TEST_MASSIVE_KEY))).toBe(
      true,
    );
  });

  test('bars never extend past the delayed data (latest = newest delayed minute)', async () => {
    const { provider } = setup();
    const nq = (await provider.resolveInstrument('NQ'))!;
    const page = await provider.getBars({
      instrument: nq,
      intervalMinutes: 1,
      end: NOW + 1,
      limit: 30,
    });
    expect(page.bars.at(-1)!.start).toBeLessThanOrEqual(NOW - 10 * MIN);
    expect(page.bars.every((b) => b.status === 'final')).toBe(true);
  });

  test('only 1-minute base bars are native', async () => {
    const { provider } = setup();
    const nq = (await provider.resolveInstrument('NQ'))!;
    expect(provider.nativeIntervalsMinutes).toEqual([1]);
    await expect(
      provider.getBars({ instrument: nq, intervalMinutes: 5, end: NOW, limit: 1 }),
    ).rejects.toBeInstanceOf(ProviderFailure);
  });

  test('requests before the ~2-year history floor return nothing (no upstream call)', async () => {
    const { provider, fake } = setup();
    const nq = (await provider.resolveInstrument('NQ'))!;
    const before = fake.requests.length;
    const page = await provider.getBars({
      instrument: nq,
      intervalMinutes: 1,
      end: Date.UTC(2023, 0, 1),
      limit: 10,
    });
    expect(page).toEqual({ bars: [], hasMore: false });
    expect(fake.requests.length).toBe(before);
  });
});

describe('sessions', () => {
  test('provider schedule inside its coverage (with a holiday), weekly schedule beyond it', async () => {
    const { provider, fake } = setup({ closedDates: ['2026-11-26'] });
    const gc = (await provider.resolveInstrument('GC'))!;
    const sessions = await provider.getSessions(gc, Date.UTC(2026, 10, 20), Date.UTC(2026, 11, 5));
    const dates = sessions.map((s) => s.sessionDate);
    expect(dates).toContain('2026-11-25');
    expect(dates).not.toContain('2026-11-26'); // holiday inside the published schedule
    expect(dates).toContain('2026-12-01'); // beyond the published range: weekly fallback
    expect(dates.every((d) => new Date(`${d}T12:00:00Z`).getUTCDay() !== 6)).toBe(true); // no Saturdays
    expect(sessions.every((s) => s.instrumentId === gc.id)).toBe(true);
    const calls = fake.requests.filter((r) => r.path === '/futures/v1/schedules').length;
    await provider.getSessions(gc, Date.UTC(2026, 10, 20), Date.UTC(2026, 11, 5));
    expect(fake.requests.filter((r) => r.path === '/futures/v1/schedules').length).toBe(calls); // cached
  });

  test('schedule failure -> unavailable with reason schedule_unavailable', async () => {
    const { provider } = setup({ failPaths: { '/futures/v1/schedules': 503 } });
    const gc = (await provider.resolveInstrument('GC'))!;
    await expect(
      provider.getSessions(gc, Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 30)),
    ).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'schedule_unavailable',
    });
  });
});

describe('errors', () => {
  test('rejected key -> unauthorized/auth_failed; entitlement -> insufficient_entitlement', async () => {
    const bad = setup({}, 'wrong-key');
    await expect(bad.provider.resolveInstrument('NQ')).rejects.toMatchObject({
      code: 'unauthorized',
      reason: 'auth_failed',
    });
    const { client } = setup();
    await expect(client.getJson('futures/v1/trades/NQZ6')).rejects.toMatchObject({
      code: 'insufficient_entitlement',
      reason: 'entitlement',
    });
  });

  test('a cursor pointing at another host is refused', async () => {
    const { client } = setup();
    await expect(client.getJson('https://evil.example/futures/v1/aggs/X')).rejects.toMatchObject({
      code: 'internal',
    });
  });
});
