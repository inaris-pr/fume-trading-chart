import { describe, expect, test } from 'vitest';
import {
  addDays,
  isoWeekday,
  isoWeekStart,
  zoneOffsetMs,
  zonedWallTimeToUtc,
} from '../src/time-zone.ts';

const NY = 'America/New_York';

describe('zonedWallTimeToUtc', () => {
  test('New York standard time (UTC-5)', () => {
    expect(zonedWallTimeToUtc('2026-03-06', '09:30', NY)).toBe(Date.UTC(2026, 2, 6, 14, 30));
  });

  test('New York daylight time (UTC-4) on the first session after the DST change', () => {
    // US DST starts Sunday 2026-03-08.
    expect(zonedWallTimeToUtc('2026-03-09', '09:30', NY)).toBe(Date.UTC(2026, 2, 9, 13, 30));
  });

  test('on the DST change day itself, times after 03:00 use the new offset', () => {
    expect(zonedWallTimeToUtc('2026-03-08', '12:00', NY)).toBe(Date.UTC(2026, 2, 8, 16, 0));
    expect(zonedWallTimeToUtc('2026-03-08', '01:00', NY)).toBe(Date.UTC(2026, 2, 8, 6, 0));
  });

  test('fall back (2026-11-01) returns to UTC-5', () => {
    expect(zonedWallTimeToUtc('2026-11-02', '09:30', NY)).toBe(Date.UTC(2026, 10, 2, 14, 30));
  });

  test('other zones', () => {
    expect(zonedWallTimeToUtc('2026-07-01', '08:30', 'America/Chicago')).toBe(
      Date.UTC(2026, 6, 1, 13, 30),
    );
    expect(zonedWallTimeToUtc('2026-07-01', '09:00', 'Asia/Tokyo')).toBe(
      Date.UTC(2026, 6, 1, 0, 0),
    );
  });

  test('offset helper', () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 15), NY)).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15), NY)).toBe(-4 * 3_600_000);
  });

  test('rejects malformed input', () => {
    expect(() => zonedWallTimeToUtc('2026-3-6', '09:30', NY)).toThrow();
    expect(() => zonedWallTimeToUtc('2026-03-06', '9:30', NY)).toThrow();
    expect(() => zonedWallTimeToUtc('2026-03-06', '24:00', NY)).toThrow();
  });
});

describe('calendar date helpers', () => {
  test('addDays crosses months and years', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('isoWeekday and isoWeekStart', () => {
    expect(isoWeekday('2026-03-02')).toBe(1); // Monday
    expect(isoWeekday('2026-03-08')).toBe(7); // Sunday
    expect(isoWeekStart('2026-03-08')).toBe('2026-03-02');
    expect(isoWeekStart('2026-03-09')).toBe('2026-03-09');
  });
});
