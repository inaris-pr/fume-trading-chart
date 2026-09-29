/**
 * Minimal IANA time-zone helpers built on Intl. No fixed offsets anywhere: DST is resolved per
 * instant by the runtime's time-zone database.
 */
import type { UnixMs } from './primitives.ts';

/** Calendar date in a session time zone, "YYYY-MM-DD". */
export type LocalDate = string;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(timeZone, f);
  }
  return f;
}

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (e.g. -4h for New York in summer). */
export function zoneOffsetMs(utcMs: UnixMs, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(utcMs);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return "${type}" for ${timeZone}`);
    return Number(part.value);
  };
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  const wholeSecondUtc = Math.floor(utcMs / 1000) * 1000;
  return wallAsUtc - wholeSecondUtc;
}

/**
 * UTC instant of wall-clock `time` ("HH:MM") on `date` in `timeZone`.
 * For wall times that do not exist (inside a spring-forward gap) the result is shifted forward by
 * the gap, which never happens for exchange session times.
 */
export function zonedWallTimeToUtc(date: LocalDate, time: string, timeZone: string): UnixMs {
  const [y, m, d] = parseLocalDate(date);
  const [hh, mm] = parseWallTime(time);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall - zoneOffsetMs(wall, timeZone);
  const corrected = wall - zoneOffsetMs(utc, timeZone);
  if (corrected !== utc) utc = corrected;
  return utc;
}

export function parseLocalDate(date: LocalDate): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid local date "${date}", expected YYYY-MM-DD`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Minutes since midnight for "HH:MM". */
export function wallTimeMinutes(time: string): number {
  const [hh, mm] = parseWallTime(time);
  return hh * 60 + mm;
}

function parseWallTime(time: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid wall time "${time}", expected HH:MM`);
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) throw new Error(`Invalid wall time "${time}"`);
  return [hh, mm];
}

/** Date arithmetic on calendar dates (no time zone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parseLocalDate(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: LocalDate): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const [y, m, d] = parseLocalDate(date);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** Monday of the ISO week containing `date`. */
export function isoWeekStart(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}
