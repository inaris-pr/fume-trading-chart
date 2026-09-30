/**
 * Exact high-precision event timestamps (docs/domain-model.md#timestamps).
 *
 * EpochNs is a canonical decimal string of integer nanoseconds since the Unix epoch. Nanosecond
 * values never pass through a JS Number (they exceed 2^53); arithmetic uses BigInt.
 */
import type { EpochNs, EventTime, UnixMs } from './primitives.ts';
import type { Trade } from './market-data.ts';

const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;
const CANONICAL = /^(0|[1-9]\d*)$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

export function isEpochNs(value: string): value is EpochNs {
  return CANONICAL.test(value);
}

/** Validates and brands a canonical epoch-ns string. */
export function toEpochNs(value: string): EpochNs {
  if (!isEpochNs(value)) throw new Error(`Not a canonical epoch-nanosecond string: "${value}"`);
  return value;
}

/**
 * Parses an RFC 3339 timestamp (e.g. "2026-03-09T13:30:00.123456789Z" or with a "+01:00" offset)
 * to exact epoch nanoseconds. Fractions of 1-9 digits are zero-extended to nanoseconds.
 * Rejects malformed input, impossible dates, leap seconds (":60") and instants before 1970.
 */
export function parseRfc3339ToEpochNs(text: string): EpochNs {
  const m = RFC3339.exec(text);
  if (!m) throw new Error(`Invalid RFC 3339 timestamp: "${text}"`);
  const [, y, mo, d, h, mi, s, frac = '', z, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid RFC 3339 timestamp: "${text}"`);
  }
  const wholeSecondsMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wholeSecondsMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date in timestamp: "${text}"`);
  }
  let offsetMinutes = 0;
  if (!z) {
    const offH = Number(oh);
    const offM = Number(om);
    if (offH > 23 || offM > 59) throw new Error(`Invalid UTC offset in timestamp: "${text}"`);
    offsetMinutes = (sign === '-' ? -1 : 1) * (offH * 60 + offM);
  }
  // Whole seconds fit a Number exactly; only the fraction needs nanosecond precision.
  const epochSeconds = BigInt(wholeSecondsMs / 1000 - offsetMinutes * 60);
  if (epochSeconds < 0n) throw new Error(`Timestamps before 1970 are not supported: "${text}"`);
  const ns = epochSeconds * NS_PER_S + BigInt(frac.padEnd(9, '0') || '0');
  return ns.toString() as EpochNs;
}

/** floor(ns / 1e6) as a UnixMs. */
export function epochNsToMs(ns: EpochNs): UnixMs {
  return Number(BigInt(ns) / NS_PER_MS);
}

/** Exact ns for a whole-millisecond instant. */
export function epochMsToNs(ms: UnixMs): EpochNs {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error(`Invalid epoch milliseconds: ${ms}`);
  return (BigInt(ms) * NS_PER_MS).toString() as EpochNs;
}

/** Orders canonical epoch-ns strings without parsing: shorter is smaller, then lexicographic. */
export function compareEpochNs(a: EpochNs, b: EpochNs): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function eventTimeFromNs(ns: EpochNs): EventTime {
  return { ns, ms: epochNsToMs(ns) };
}

export function eventTimeFromRfc3339(text: string): EventTime {
  return eventTimeFromNs(parseRfc3339ToEpochNs(text));
}

export function eventTimeFromMs(ms: UnixMs): EventTime {
  return { ns: epochMsToNs(ms), ms };
}

/** Adds a (possibly large) nanosecond offset exactly. */
export function addNs(ns: EpochNs, deltaNs: bigint): EpochNs {
  const next = BigInt(ns) + deltaNs;
  if (next < 0n) throw new Error('Resulting timestamp is before 1970');
  return next.toString() as EpochNs;
}

/**
 * Deterministic trade ordering: (time.ns, ingestSeq). Trades without ingestSeq sort before those
 * with one at the same nanosecond (they are only possible outside the hub path).
 */
export function compareTradeOrder(
  a: Pick<Trade, 'time' | 'ingestSeq'>,
  b: Pick<Trade, 'time' | 'ingestSeq'>,
): number {
  return compareEpochNs(a.time.ns, b.time.ns) || (a.ingestSeq ?? -1) - (b.ingestSeq ?? -1);
}
