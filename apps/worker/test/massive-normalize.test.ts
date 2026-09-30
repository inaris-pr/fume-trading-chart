/**
 * Massive futures normalization: numeric strings, aggregates, contract codes/months, decimal
 * metadata, schedule de-duplication, holidays/early closes and the weekly fallback. Payload shapes
 * follow the 2026-09-30 spike observations (docs/research.md); values are synthetic.
 */
import { describe, expect, test } from 'vitest';
import type { InstrumentId } from '@fume/core';
import { ProviderFailure } from '../src/errors.ts';
import {
  checkAggregate,
  contractCode,
  contractMonthOf,
  mergeWithWeekly,
  multiplyDecimal,
  normalizeContract,
  normalizeProduct,
  normalizeRestAggregate,
  normalizeScheduleRows,
  normalizeSnapshot,
  priceDecimals,
  scheduleToSessions,
  toDecimal,
  toFiniteNumber,
} from '../src/providers/massive/normalize.ts';

const MIN = 60_000;
const ID = 'fut:NQ:2026-12' as InstrumentId;
const T = Date.UTC(2026, 8, 30, 17, 22);

describe('numeric normalization', () => {
  test('numbers and numeric strings become finite numbers; anything else is null', () => {
    expect(toFiniteNumber(30805.5)).toBe(30805.5);
    expect(toFiniteNumber('30805.5')).toBe(30805.5);
    expect(toFiniteNumber(' 61.25 ')).toBe(61.25);
    expect(toFiniteNumber('1e3')).toBe(1000);
    expect(toFiniteNumber('')).toBeNull();
    expect(toFiniteNumber('12abc')).toBeNull();
    expect(toFiniteNumber(Number.NaN)).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
  });

  test('a stream-style aggregate with string prices normalizes like a REST one', () => {
    const fromStrings = checkAggregate(
      {
        start: T,
        open: '30790',
        high: '30790.25',
        low: '30788.75',
        close: '30789',
        volume: 15,
        trades: 11,
      },
      1000,
    );
    const fromNumbers = checkAggregate(
      {
        start: T,
        open: 30790,
        high: 30790.25,
        low: 30788.75,
        close: 30789,
        volume: 15,
        trades: 11,
      },
      1000,
    );
    expect(fromStrings).toEqual(fromNumbers);
    expect(fromStrings).toEqual({
      start: T,
      open: 30790,
      high: 30790.25,
      low: 30788.75,
      close: 30789,
      volume: 15,
      tradeCount: 11,
    });
  });

  test('malformed aggregates are rejected, never guessed', () => {
    const ok = { start: T, open: 1, high: 2, low: 1, close: 2, volume: 1, trades: 1 };
    for (const bad of [
      { ...ok, start: T + 500 }, // not aligned
      { ...ok, high: 0.5 }, // high < low
      { ...ok, open: 'x' },
      { ...ok, volume: -1 },
      { ...ok, trades: 1.5 },
    ]) {
      expect(() => checkAggregate(bad, 1000)).toThrow(ProviderFailure);
    }
  });
});

describe('REST aggregates', () => {
  test('window_start ns -> ms start; OHLCV + trade count; final once the minute ended', () => {
    const raw = {
      ticker: 'NQZ6',
      window_start: T * 1_000_000,
      session_end_date: '2026-09-30',
      open: 30805.5,
      high: 30809.75,
      low: 30794,
      close: 30799.25,
      volume: 992,
      transactions: 695,
      dollar_volume: 30541234.5,
    };
    expect(normalizeRestAggregate(raw, MIN, T + MIN)).toEqual({
      start: T,
      open: 30805.5,
      high: 30809.75,
      low: 30794,
      close: 30799.25,
      volume: 992,
      tradeCount: 695,
      status: 'final',
      revision: 0,
    });
    expect(normalizeRestAggregate(raw, MIN, T + 30_000).status).toBe('provisional');
  });

  test('a start that is not a whole minute is rejected', () => {
    const raw = {
      window_start: (T + 1000) * 1_000_000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    };
    expect(() => normalizeRestAggregate(raw, MIN, T)).toThrow(ProviderFailure);
  });
});

describe('contracts', () => {
  test('CME contract month codes: decade inferred from the last trade date', () => {
    expect(contractMonthOf('NQZ6', 'NQ', '2026-12-18')).toBe('2026-12');
    // CL January 2027 stops trading in December 2026.
    expect(contractMonthOf('CLF7', 'CL', '2026-12-21')).toBe('2027-01');
    expect(contractMonthOf('GCZ6', 'GC', '2026-12-29')).toBe('2026-12');
    expect(contractMonthOf('NQZ6', 'GC', '2026-12-18')).toBeNull();
    expect(contractMonthOf('NQ-X', 'NQ', '2026-12-18')).toBeNull();
    expect(contractCode('NQ', '2026-12')).toBe('NQZ6');
    expect(contractCode('CL', '2027-01')).toBe('CLF7');
    expect(contractCode('NQ', '2026-13')).toBeNull();
  });

  test('single contracts normalize; combos and other products are skipped', () => {
    const row = {
      ticker: 'NQZ6',
      product_code: 'NQ',
      first_trade_date: '2022-05-22',
      last_trade_date: '2026-12-18',
      settlement_date: '2026-12-18',
      trade_tick_size: 0.25,
      trading_venue: 'XCME',
      type: 'single',
    };
    expect(normalizeContract(row, 'NQ')).toEqual({
      ticker: 'NQZ6',
      root: 'NQ',
      contractMonth: '2026-12',
      firstTradeDate: '2022-05-22',
      lastTradeDate: '2026-12-18',
      settlementDate: '2026-12-18',
      tradeTickSize: 0.25,
      tradingVenue: 'XCME',
    });
    expect(normalizeContract({ ...row, ticker: 'NQZ6-NQH7', type: 'combo' }, 'NQ')).toBeNull();
    expect(normalizeContract(row, 'YM')).toBeNull();
    expect(() => normalizeContract({ ...row, trade_tick_size: 0 }, 'NQ')).toThrow(ProviderFailure);
  });

  test('products give the contract size (multiplier); tick value = tick x size, exactly', () => {
    const p = normalizeProduct(
      {
        product_code: 'SI',
        name: 'Silver Futures',
        unit_of_measure_qty: 5000,
        trade_currency_code: 'USD',
      },
      'SI',
    );
    expect(p).toMatchObject({ unitQty: 5000, currency: 'USD', name: 'Silver Futures' });
    expect(multiplyDecimal(0.005, 5000)).toBe('25');
    expect(multiplyDecimal(0.25, 20)).toBe('5');
    expect(multiplyDecimal(0.1, 100)).toBe('10');
    expect(multiplyDecimal(0.01, 1000)).toBe('10');
    expect(multiplyDecimal(1, 5)).toBe('5');
    expect(toDecimal(0.005)).toBe('0.005');
    expect(toDecimal(100)).toBe('100');
    expect([0.25, 0.005, 0.1, 1].map(priceDecimals)).toEqual([2, 3, 1, 0]);
  });

  test('snapshot rows: ticker from details, session volume, delayed last trade time', () => {
    expect(
      normalizeSnapshot({
        details: { ticker: 'GCZ6' },
        session: { volume: 127082 },
        last_trade: { timeframe: 'DELAYED', last_updated: 1790789177324000000 },
      }),
    ).toEqual({ ticker: 'GCZ6', sessionVolume: 127082, lastTradeMs: 1790789177324 });
    expect(normalizeSnapshot({ session: {} })).toBeNull();
  });
});

describe('schedules -> sessions', () => {
  const row = (event: string, date: string, ts: string) => ({
    event,
    product_code: 'NQ',
    session_end_date: date,
    timestamp: ts,
    trading_venue: 'XCME',
  });
  // Normal day: open 17:00 CT (22:00Z) the evening before, close 16:00 CT (21:00Z).
  const normal = [
    row('pre_open', '2026-09-30', '2026-09-29T21:45:00+00:00'),
    row('open', '2026-09-30', '2026-09-29T22:00:00+00:00'),
    row('close', '2026-09-30', '2026-09-30T21:00:00+00:00'),
  ];

  test('rows are de-duplicated (the API repeats every event)', () => {
    const events = normalizeScheduleRows(
      [...normal, ...normal, ...normal, row('open', '2026-09-30', '2026-09-29T22:00:00+00:00')],
      'NQ',
    );
    expect(events).toHaveLength(3);
  });

  test('a normal session is one window from open to close (the daily break is the gap)', () => {
    const [session] = scheduleToSessions(normalizeScheduleRows(normal, 'NQ'), ID);
    expect(session).toEqual({
      instrumentId: ID,
      sessionDate: '2026-09-30',
      windows: [
        { start: Date.UTC(2026, 8, 29, 22), end: Date.UTC(2026, 8, 30, 21), kind: 'regular' },
      ],
    });
  });

  test('Sunday open belongs to the Monday session', () => {
    const [monday] = scheduleToSessions(
      normalizeScheduleRows(
        [
          row('pre_open', '2026-09-28', '2026-09-27T21:00:00+00:00'),
          row('open', '2026-09-28', '2026-09-27T22:00:00+00:00'),
          row('close', '2026-09-28', '2026-09-28T21:00:00+00:00'),
        ],
        'NQ',
      ),
      ID,
    );
    expect(monday!.sessionDate).toBe('2026-09-28');
    expect(new Date(monday!.windows[0]!.start).getUTCDay()).toBe(0); // Sunday
  });

  test('holiday: the halt is a later pre_open/open pair; early close ends the session (Thanksgiving 2025 shape)', () => {
    const rows = [
      row('pre_open', '2025-11-28', '2025-11-26T22:45:00+00:00'),
      row('open', '2025-11-28', '2025-11-26T23:00:00+00:00'),
      row('pre_open', '2025-11-28', '2025-11-27T18:00:00+00:00'),
      row('open', '2025-11-28', '2025-11-27T23:00:00+00:00'),
      row('pre_open', '2025-11-28', '2025-11-28T13:00:00+00:00'),
      row('open', '2025-11-28', '2025-11-28T13:30:00+00:00'),
      row('close', '2025-11-28', '2025-11-28T18:15:00+00:00'),
    ];
    const [s] = scheduleToSessions(normalizeScheduleRows(rows, 'NQ'), ID);
    expect(
      s!.windows.map((w) => [new Date(w.start).toISOString(), new Date(w.end).toISOString()]),
    ).toEqual([
      ['2025-11-26T23:00:00.000Z', '2025-11-27T18:00:00.000Z'],
      ['2025-11-27T23:00:00.000Z', '2025-11-28T13:00:00.000Z'],
      ['2025-11-28T13:30:00.000Z', '2025-11-28T18:15:00.000Z'],
    ]);
  });

  test('a window that never closes is dropped, not guessed', () => {
    const sessions = scheduleToSessions(
      normalizeScheduleRows([row('open', '2026-09-30', '2026-09-29T22:00:00+00:00')], 'NQ'),
      ID,
    );
    expect(sessions).toEqual([]);
  });

  test('covered dates without rows are holidays; uncovered dates use the weekly Globex schedule', () => {
    const provider = scheduleToSessions(normalizeScheduleRows(normal, 'NQ'), ID);
    const merged = mergeWithWeekly({
      provider,
      coveredFrom: '2026-09-28',
      coveredTo: '2026-10-01',
      fromDate: '2026-09-28',
      toDate: '2026-10-05',
      instrumentId: ID,
    });
    // 09-28, 09-29 and 10-01 are covered but have no rows here -> closed. 10-02 and 10-05 fall back.
    expect(merged.map((s) => s.sessionDate)).toEqual(['2026-09-30', '2026-10-02', '2026-10-05']);
    const friday = merged[1]!;
    // Weekly fallback: 17:00 CT Thursday -> 16:00 CT Friday (CDT: 22:00Z -> 21:00Z).
    expect(friday.windows).toEqual([
      { start: Date.UTC(2026, 9, 1, 22), end: Date.UTC(2026, 9, 2, 21), kind: 'regular' },
    ]);
  });
});
