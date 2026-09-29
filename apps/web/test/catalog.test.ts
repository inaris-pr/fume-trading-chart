import { describe, expect, test } from 'vitest';
import type { Bar } from '@fume/core';
import {
  DEMO_SYMBOLS,
  demoGaps,
  DemoCatalog,
  FIRST_SESSION_DATE,
  isDemoSymbol,
  isTimeframe,
  TIMEFRAME_LABELS,
  TIMEFRAME_ORDER,
} from '../src/demo/catalog.ts';

const catalog = new DemoCatalog();
const MIN = 60_000;
const HOUR = 60 * MIN;
const nyTime = (t: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);

describe('demo calendar', () => {
  test('170 weekday RTH sessions from 2026-02-02, calendar resolved beyond the data', () => {
    expect(catalog.sessions).toHaveLength(170);
    expect(catalog.sessions[0]!.sessionDate).toBe(FIRST_SESSION_DATE);
    expect(catalog.sessions.at(-1)!.sessionDate).toBe('2026-09-25');
    expect(catalog.calendar.length).toBeGreaterThan(catalog.sessions.length);
  });
});

describe('symbols', () => {
  test('all five demo symbols build, with distinct deterministic series', () => {
    const closes = DEMO_SYMBOLS.map((s) => catalog.get(s, '5m').bars.at(-1)!.close);
    expect(new Set(closes).size).toBe(5);
    const fresh = new DemoCatalog();
    for (const s of DEMO_SYMBOLS) {
      expect(fresh.get(s, '15m').bars).toEqual(catalog.get(s, '15m').bars);
    }
  });

  test('provider-neutral instrument metadata and formatting per symbol', () => {
    for (const s of DEMO_SYMBOLS) {
      const series = catalog.get(s, '1d');
      expect(series.instrument.displaySymbol).toBe(s);
      expect(series.instrument.marketDataRef.providerId).toBe('replay');
      expect(series.minPriceStep).toBe(0.01);
      expect(series.formatPrice(series.bars[0]!.open)).toMatch(/^\d+\.\d\d$/);
    }
  });

  test('same symbol + timeframe returns the cached, identical series object', () => {
    expect(catalog.get('SPY', '5m')).toBe(catalog.get('SPY', '5m'));
  });

  test('timeframe controls: exact order and labels 1D | 4H | 1H | 15m | 5m | 1m', () => {
    expect(TIMEFRAME_ORDER.map((tf) => TIMEFRAME_LABELS[tf])).toEqual([
      '1D',
      '4H',
      '1H',
      '15m',
      '5m',
      '1m',
    ]);
  });

  test('symbol/timeframe guards', () => {
    expect(isDemoSymbol('NVDA')).toBe(true);
    expect(isDemoSymbol('SYN-NEG')).toBe(true);
    expect(isDemoSymbol('MSFT')).toBe(false);
    expect(TIMEFRAME_ORDER.every(isTimeframe)).toBe(true);
    expect(isTimeframe('2h')).toBe(false);
  });
});

describe('timeframes change the actual candles (canonical aggregation)', () => {
  const minutes = catalog.minuteBars('SPY');
  const counts = Object.fromEntries(
    TIMEFRAME_ORDER.map((tf) => [tf, catalog.get('SPY', tf).bars.length]),
  );

  test('bar counts per timeframe', () => {
    const sessions = 170;
    const missingMinutes = demoGaps(sessions * 390).length;
    expect(counts['1m']).toBe(sessions * 390 - missingMinutes);
    expect(counts['5m']).toBe(sessions * 78 - 4); // the 20-minute halt empties four 5m slots
    expect(counts['15m']).toBe(sessions * 26 - 1); // the halt fully empties the 13:00-13:15 bucket
    expect(counts['1h']).toBe(sessions * 7);
    expect(counts['4h']).toBe(sessions * 2);
    expect(counts['1d']).toBe(sessions);
  });

  test('each timeframe has its real bucket duration (not relabelled 5m bars)', () => {
    const dur = (bars: readonly Bar[]) =>
      Math.min(...bars.slice(0, 20).map((b, i, a) => (i ? b.start - a[i - 1]!.start : Infinity)));
    expect(dur(catalog.get('SPY', '1m').bars)).toBe(MIN);
    expect(dur(catalog.get('SPY', '5m').bars)).toBe(5 * MIN);
    expect(dur(catalog.get('SPY', '15m').bars)).toBe(15 * MIN);
    expect(dur(catalog.get('SPY', '1h').bars)).toBe(HOUR);
    expect(dur(catalog.get('SPY', '4h').bars)).toBe(4 * HOUR);
  });

  test('4H candles are real session-aligned aggregates: 09:30-13:30 and 13:30-16:00', () => {
    const fourH = catalog.get('SPY', '4h').bars;
    expect(fourH.slice(0, 4).map((b) => nyTime(b.start))).toEqual([
      '09:30',
      '13:30',
      '09:30',
      '13:30',
    ]);
    const [morning, afternoon] = fourH;
    const first = minutes.slice(0, 240);
    const second = minutes.slice(240, 390);
    expect(morning).toMatchObject({
      open: first[0]!.open,
      high: Math.max(...first.map((m) => m.high)),
      low: Math.min(...first.map((m) => m.low)),
      close: first.at(-1)!.close,
      volume: first.reduce((n, m) => n + m.volume, 0),
    });
    expect(afternoon!.close).toBe(second.at(-1)!.close);
    expect(afternoon!.volume).toBe(second.reduce((n, m) => n + m.volume, 0));
    // Genuinely different from 1H and 1D.
    const oneH = catalog.get('SPY', '1h').bars;
    const oneD = catalog.get('SPY', '1d').bars;
    expect(fourH.length).not.toBe(oneH.length);
    expect(fourH.length).not.toBe(oneD.length);
    expect(morning!.volume).toBeGreaterThan(oneH[0]!.volume);
    expect(morning!.volume).toBeLessThan(oneD[0]!.volume);
    expect(morning!.volume + afternoon!.volume).toBe(oneD[0]!.volume);
  });

  test('1h candles are session-aligned: 09:30, 10:30, ... 15:30', () => {
    const starts = catalog
      .get('SPY', '1h')
      .bars.slice(0, 7)
      .map((b) => nyTime(b.start));
    expect(starts).toEqual(['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30']);
  });

  test('daily candle = the whole session of minutes', () => {
    const day = catalog.get('SPY', '1d').bars[0]!;
    const session = minutes.slice(0, 390);
    expect(day.open).toBe(session[0]!.open);
    expect(day.close).toBe(session.at(-1)!.close);
    expect(day.high).toBe(Math.max(...session.map((m) => m.high)));
    expect(day.low).toBe(Math.min(...session.map((m) => m.low)));
    expect(day.volume).toBe(session.reduce((n, m) => n + m.volume, 0));
  });

  test('every timeframe maps onto its own time scale without unmapped bars', () => {
    for (const tf of TIMEFRAME_ORDER) {
      const s = catalog.get('NVDA', tf);
      expect(s.bars.every((b) => s.timeScale.toSlot(b.start) !== null)).toBe(true);
    }
  });

  test('dev edge-case series still work across timeframes', () => {
    const neg = catalog.get('SYN-NEG', '1d').bars;
    expect(neg[0]!.open).toBeGreaterThan(0);
    expect(neg.some((b) => b.low < 0)).toBe(true);
    const recent = catalog.get('SYN-NEG', '5m').bars.slice(-78 * 20);
    expect(recent.some((b) => b.close > 0) && recent.some((b) => b.close < 0)).toBe(true);
    expect(catalog.get('SYN-SUB', '1h').minPriceStep).toBe(0.0001);
    const flat = catalog.get('SYN-FLAT', '15m').bars;
    expect(new Set(flat.flatMap((b) => [b.open, b.high, b.low, b.close])).size).toBe(1);
  });
});
