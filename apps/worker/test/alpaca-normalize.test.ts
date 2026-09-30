import { describe, expect, test } from 'vitest';
import type { InstrumentId } from '@fume/core';
import { ProviderFailure } from '../src/errors.ts';
import {
  exchangeMic,
  isBeforeExclusiveEnd,
  localDate,
  normalizeAsset,
  normalizeBar,
  normalizeBars,
  normalizeCalendar,
  parseBarsPage,
  toAlpacaInclusiveEnd,
} from '../src/providers/alpaca/normalize.ts';

const MIN = 60_000;
const later = Date.UTC(2030, 0, 1);
const raw = (t: string, extra: Record<string, unknown> = {}) => ({
  t,
  o: 600.1,
  h: 600.5,
  l: 599.9,
  c: 600.2,
  v: 1234,
  n: 17,
  vw: 600.21,
  ...extra,
});
const rejects = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderFailure);
    expect((error as ProviderFailure).code).toBe('internal');
    return;
  }
  throw new Error('expected rejection');
};

describe('bar normalization', () => {
  test('maps t/o/h/l/c/v/n/vw; t is the bar START', () => {
    const bar = normalizeBar(raw('2026-09-25T13:30:00Z'), MIN, later);
    expect(bar).toEqual({
      start: Date.UTC(2026, 8, 25, 13, 30),
      open: 600.1,
      high: 600.5,
      low: 599.9,
      close: 600.2,
      volume: 1234,
      tradeCount: 17,
      vwap: 600.21,
      status: 'final',
      revision: 0,
    });
  });

  test('n and vw are optional', () => {
    const bar = normalizeBar(
      { t: '2026-09-25T13:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 0 },
      MIN,
      later,
    );
    expect(bar).not.toHaveProperty('tradeCount');
    expect(bar).not.toHaveProperty('vwap');
  });

  test('RFC 3339 with offsets and nanosecond zeros is exact', () => {
    expect(normalizeBar(raw('2026-09-25T09:30:00-04:00'), MIN, later).start).toBe(
      Date.UTC(2026, 8, 25, 13, 30),
    );
    expect(normalizeBar(raw('2026-09-25T13:30:00.000000000Z'), MIN, later).start).toBe(
      Date.UTC(2026, 8, 25, 13, 30),
    );
  });

  test('5m and 15m bars must be epoch-aligned to their interval', () => {
    expect(normalizeBar(raw('2026-09-25T13:45:00Z'), 15 * MIN, later).start % (15 * MIN)).toBe(0);
    expect(normalizeBar(raw('2026-09-25T13:35:00Z'), 5 * MIN, later).start % (5 * MIN)).toBe(0);
    rejects(() => normalizeBar(raw('2026-09-25T13:35:00Z'), 15 * MIN, later));
    rejects(() => normalizeBar(raw('2026-09-25T13:30:30Z'), MIN, later));
  });

  test('status: final once the interval has ended, provisional while in progress', () => {
    const start = Date.UTC(2026, 8, 25, 13, 30);
    expect(normalizeBar(raw('2026-09-25T13:30:00Z'), MIN, start + MIN).status).toBe('final');
    expect(normalizeBar(raw('2026-09-25T13:30:00Z'), MIN, start + MIN - 1).status).toBe(
      'provisional',
    );
  });

  test.each([
    ['missing t', { t: undefined }],
    ['bad timestamp', { t: 'yesterday' }],
    ['sub-millisecond timestamp', { t: '2026-09-25T13:30:00.000000500Z' }],
    ['non-finite price', { o: Number.NaN }],
    ['string price', { h: '600.5' }],
    ['high < low', { h: 599, l: 600 }],
    ['open outside range', { o: 601 }],
    ['close outside range', { c: 599 }],
    ['negative volume', { v: -1 }],
    ['fractional trade count', { n: 1.5 }],
    ['non-finite vwap', { vw: Number.POSITIVE_INFINITY }],
  ])('rejects a malformed bar: %s', (_label, patch) => {
    rejects(() => normalizeBar({ ...raw('2026-09-25T13:30:00Z'), ...patch }, MIN, later));
  });

  test('sorts ascending, de-duplicates deterministically (last occurrence wins), ignores unknown fields', () => {
    const result = normalizeBars(
      [
        raw('2026-09-25T13:32:00Z'),
        raw('2026-09-25T13:30:00Z', { extra: 'ignored' }),
        raw('2026-09-25T13:31:00Z'),
        raw('2026-09-25T13:30:00Z', { c: 600.4 }),
      ],
      MIN,
      later,
    );
    expect(result.duplicates).toBe(1);
    expect(result.bars.map((b) => (b.start - Date.UTC(2026, 8, 25, 13, 30)) / MIN)).toEqual([
      0, 1, 2,
    ]);
    expect(result.bars[0]!.close).toBe(600.4);
    expect(result.bars[0]).not.toHaveProperty('extra');
  });

  test('bars page envelope: null bars is an empty page; bad envelopes are rejected', () => {
    expect(parseBarsPage({ bars: null, symbol: 'SPY', next_page_token: null })).toEqual({
      bars: [],
      nextPageToken: null,
    });
    expect(parseBarsPage({ bars: [], next_page_token: 'abc' }).nextPageToken).toBe('abc');
    rejects(() => parseBarsPage([]));
    rejects(() => parseBarsPage({ bars: 'x' }));
    rejects(() => parseBarsPage({ bars: [], next_page_token: 5 }));
  });
});

describe('exclusive end conversion (one helper)', () => {
  test('Fume end is exclusive: Alpaca inclusive end is 1 ms earlier; start === end is excluded', () => {
    const end = Date.UTC(2026, 8, 25, 14, 0);
    expect(toAlpacaInclusiveEnd(end)).toBe('2026-09-25T13:59:59.999Z');
    expect(isBeforeExclusiveEnd(end - MIN, end)).toBe(true);
    expect(isBeforeExclusiveEnd(end, end)).toBe(false);
  });
});

describe('asset normalization', () => {
  const spy = {
    id: '00000000-0000-4000-8000-000000000000',
    class: 'us_equity',
    exchange: 'ARCA',
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    status: 'active',
    tradable: true,
    marginable: true,
    shortable: true,
    easy_to_borrow: true,
    fractionable: true,
  };

  test('SPY -> provider-neutral Instrument (no ETF guess from name or ticker)', () => {
    const instrument = normalizeAsset(spy, 'SPY')!;
    expect(instrument).toMatchObject({
      id: 'eq:SPY',
      assetClass: 'equity',
      displaySymbol: 'SPY',
      description: 'SPDR S&P 500 ETF Trust',
      exchange: 'ARCX',
      currency: 'USD',
      quantityUnit: 'shares',
      contractMultiplier: '1',
      tradable: true,
      shortable: true,
      marketDataRef: { providerId: 'alpaca', symbol: 'SPY' },
    });
    expect(instrument.session.timezone).toBe('America/New_York');
    expect(instrument).not.toHaveProperty('marginable');
  });

  test('tradable/shortable come from the provider; missing shortable is "unknown"', () => {
    const { shortable: _s, ...noShort } = spy;
    expect(normalizeAsset({ ...noShort, tradable: false }, 'SPY')).toMatchObject({
      tradable: false,
      shortable: 'unknown',
    });
  });

  test('inactive assets and other classes are not found (null)', () => {
    expect(normalizeAsset({ ...spy, status: 'inactive' }, 'SPY')).toBeNull();
    expect(normalizeAsset({ ...spy, class: 'crypto' }, 'SPY')).toBeNull();
  });

  test('exchange codes map to MICs only where unambiguous; others are omitted', () => {
    expect(exchangeMic('NYSE')).toBe('XNYS');
    expect(exchangeMic('NASDAQ')).toBe('XNAS');
    expect(exchangeMic('ARCA')).toBe('ARCX');
    expect(exchangeMic('AMEX')).toBe('XASE');
    expect(exchangeMic('BATS')).toBe('BATS');
    expect(exchangeMic('OTC')).toBeUndefined();
    expect(normalizeAsset({ ...spy, exchange: 'OTC' }, 'SPY')).not.toHaveProperty('exchange');
  });

  test('malformed or mismatched assets are rejected', () => {
    rejects(() => normalizeAsset({ ...spy, tradable: 'yes' }, 'SPY'));
    rejects(() => normalizeAsset({ ...spy, symbol: 'QQQ' }, 'SPY'));
    rejects(() => normalizeAsset(null, 'SPY'));
  });
});

describe('calendar normalization', () => {
  const id = 'eq:SPY' as InstrumentId;

  test("normal day: one regular window from the day's open/close in New York time", () => {
    const [s] = normalizeCalendar([{ date: '2026-09-25', open: '09:30', close: '16:00' }], id);
    expect(s).toEqual({
      instrumentId: id,
      sessionDate: '2026-09-25',
      windows: [
        {
          start: Date.UTC(2026, 8, 25, 13, 30),
          end: Date.UTC(2026, 8, 25, 20, 0),
          kind: 'regular',
        },
      ],
    });
  });

  test('early close comes from the calendar (13:00), not from a hard-coded 16:00', () => {
    const [s] = normalizeCalendar([{ date: '2025-11-28', open: '09:30', close: '13:00' }], id);
    expect(s!.windows[0]).toEqual({
      start: Date.UTC(2025, 10, 28, 14, 30),
      end: Date.UTC(2025, 10, 28, 18, 0),
      kind: 'regular',
    });
  });

  test('DST: the same 09:30 open is 13:30Z in summer and 14:30Z in winter', () => {
    const sessions = normalizeCalendar(
      [
        { date: '2026-03-09', open: '09:30', close: '16:00' }, // after spring-forward
        { date: '2026-03-06', open: '09:30', close: '16:00' }, // before
        { date: '2026-11-02', open: '09:30', close: '16:00' }, // after fall-back
        { date: '2026-10-30', open: '09:30', close: '16:00' },
      ],
      id,
    );
    expect(
      sessions.map((s) => [
        s.sessionDate,
        new Date(s.windows[0]!.start).toISOString().slice(11, 16),
      ]),
    ).toEqual([
      ['2026-03-06', '14:30'],
      ['2026-03-09', '13:30'],
      ['2026-10-30', '13:30'],
      ['2026-11-02', '14:30'],
    ]);
  });

  test('weekends and holidays are simply absent (no manual holiday list); output ascending and unique', () => {
    const sessions = normalizeCalendar(
      [
        { date: '2025-12-26', open: '09:30', close: '16:00' },
        { date: '2025-12-24', open: '09:30', close: '13:00' },
        { date: '2025-12-24', open: '09:30', close: '13:00' },
        { date: '2025-12-23', open: '09:30', close: '16:00' },
      ],
      id,
    );
    expect(sessions.map((s) => s.sessionDate)).toEqual(['2025-12-23', '2025-12-24', '2025-12-26']);
  });

  test.each([
    ['not an array', {}],
    ['bad date', [{ date: '2026/09/25', open: '09:30', close: '16:00' }]],
    ['bad time', [{ date: '2026-09-25', open: '9:30', close: '16:00' }]],
    ['close before open', [{ date: '2026-09-25', open: '16:00', close: '09:30' }]],
  ])('rejects a malformed calendar: %s', (_label, body) => {
    rejects(() => normalizeCalendar(body, id));
  });

  test('localDate uses the market time zone', () => {
    expect(localDate(Date.UTC(2026, 8, 26, 2, 0), 'America/New_York')).toBe('2026-09-25');
  });
});
