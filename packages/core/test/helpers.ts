import type { InstrumentId, SessionWindow, TradingSessionSpec } from '../src/index.ts';

export const TEST_ID = 'eq:TEST' as InstrumentId;

const weekdays = (start: string, end: string): SessionWindow[] =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));

/** US equity style: RTH 09:30-16:00 ET, pre 04:00-09:30, post 16:00-20:00, weekdays. */
export const EQUITY_SPEC: TradingSessionSpec = {
  timezone: 'America/New_York',
  regular: weekdays('09:30', '16:00'),
  extended: [...weekdays('04:00', '09:30'), ...weekdays('16:00', '20:00')],
  calendarId: 'TEST',
};

/**
 * Futures style: opens Sunday-Thursday 17:00 CT and trades overnight (window crosses midnight)
 * until 08:00, breaks 08:00-08:30, then trades 08:30-16:00. Sessions belong to the day they end.
 */
export const FUTURES_SPEC: TradingSessionSpec = {
  timezone: 'America/Chicago',
  regular: [
    ...([7, 1, 2, 3, 4] as const).map((startDay) => ({ startDay, start: '17:00', end: '08:00' })),
    ...([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start: '08:30', end: '16:00' })),
  ],
  extended: [],
  calendarId: 'TEST-FUT',
};

export const MIN = 60_000;
export const HOUR = 3_600_000;
