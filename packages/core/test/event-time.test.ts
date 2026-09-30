import { describe, expect, test } from 'vitest';
import {
  addNs,
  compareEpochNs,
  compareTradeOrder,
  epochMsToNs,
  epochNsToMs,
  eventTimeFromMs,
  eventTimeFromRfc3339,
  isEpochNs,
  parseRfc3339ToEpochNs,
  toEpochNs,
} from '../src/event-time.ts';
import type { EpochNs } from '../src/index.ts';

const ns = (s: string) => toEpochNs(s);
const base = Date.UTC(2026, 2, 9, 13, 30, 0) / 1000; // 1773063000

describe('parseRfc3339ToEpochNs', () => {
  test('no fractional seconds', () => {
    expect(parseRfc3339ToEpochNs('2026-03-09T13:30:00Z')).toBe(`${base}000000000`);
  });

  test('milliseconds, microseconds and nanoseconds are exact (zero-extended)', () => {
    expect(parseRfc3339ToEpochNs('2026-03-09T13:30:00.123Z')).toBe(`${base}123000000`);
    expect(parseRfc3339ToEpochNs('2026-03-09T13:30:00.123456Z')).toBe(`${base}123456000`);
    expect(parseRfc3339ToEpochNs('2026-03-09T13:30:00.123456789Z')).toBe(`${base}123456789`);
    expect(parseRfc3339ToEpochNs('2026-03-09T13:30:00.5Z')).toBe(`${base}500000000`);
    expect(parseRfc3339ToEpochNs('2026-03-09T13:30:00.000000001Z')).toBe(`${base}000000001`);
  });

  test('values are far beyond 2^53 and survive exactly (no Number conversion)', () => {
    const v = parseRfc3339ToEpochNs('2026-03-09T13:30:00.999999999Z');
    expect(BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(v).toBe('1773063000999999999');
    // A float would have rounded this:
    expect(String(Number(v))).not.toBe(v);
  });

  test('UTC offsets are applied (and lower-case z / t accepted)', () => {
    expect(parseRfc3339ToEpochNs('2026-03-09T09:30:00.000000007-04:00')).toBe(`${base}000000007`);
    expect(parseRfc3339ToEpochNs('2026-03-09T14:30:00+01:00')).toBe(`${base}000000000`);
    expect(parseRfc3339ToEpochNs('2026-03-09t13:30:00z')).toBe(`${base}000000000`);
    expect(parseRfc3339ToEpochNs('2026-03-09T19:00:00+05:30')).toBe(`${base}000000000`);
  });

  test('invalid timestamps are rejected', () => {
    for (const bad of [
      '',
      '2026-03-09',
      '2026-03-09 13:30:00Z',
      '2026-03-09T13:30:00',
      '2026-03-09T13:30:00.1234567890Z',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-03-09T24:00:00Z',
      '2026-03-09T13:60:00Z',
      '2026-03-09T13:30:60Z',
      '2026-03-09T13:30:00+25:00',
      '1969-12-31T23:59:59Z',
      '2026-03-09T13:30:00.Z',
    ]) {
      expect(() => parseRfc3339ToEpochNs(bad), bad).toThrow();
    }
  });
});

describe('conversions', () => {
  test('ms = floor(ns / 1e6)', () => {
    expect(epochNsToMs(ns('1773063000123999999'))).toBe(1773063000123);
    expect(epochNsToMs(ns('999999'))).toBe(0);
    expect(epochNsToMs(ns('1000000'))).toBe(1);
  });

  test('ms -> ns and EventTime builders', () => {
    expect(epochMsToNs(1773063000123)).toBe('1773063000123000000');
    expect(eventTimeFromMs(5)).toEqual({ ns: '5000000', ms: 5 });
    expect(eventTimeFromRfc3339('2026-03-09T13:30:00.000500001Z')).toEqual({
      ns: `${base}000500001`,
      ms: base * 1000,
    });
    expect(() => epochMsToNs(1.5)).toThrow();
    expect(() => epochMsToNs(-1)).toThrow();
  });

  test('canonical form validation', () => {
    expect(isEpochNs('0')).toBe(true);
    expect(isEpochNs('1773063000123456789')).toBe(true);
    for (const bad of ['', '01', '-1', '1.5', '1e18', ' 1']) expect(isEpochNs(bad)).toBe(false);
    expect(() => toEpochNs('01')).toThrow();
  });

  test('addNs is exact', () => {
    expect(addNs(ns('1773063000999999999'), 1n)).toBe('1773063001000000000');
    expect(() => addNs(ns('5'), -6n)).toThrow();
  });
});

describe('ordering', () => {
  const t = (s: string) => parseRfc3339ToEpochNs(s);

  test('around a second boundary', () => {
    expect(
      compareEpochNs(t('2026-03-09T13:30:00.999999999Z'), t('2026-03-09T13:30:01Z')),
    ).toBeLessThan(0);
    expect(
      compareEpochNs(t('2026-03-09T13:30:01Z'), t('2026-03-09T13:30:00.999999999Z')),
    ).toBeGreaterThan(0);
  });

  test('when only sub-millisecond digits differ', () => {
    const a = t('2026-03-09T13:30:00.123000001Z');
    const b = t('2026-03-09T13:30:00.123000002Z');
    expect(epochNsToMs(a)).toBe(epochNsToMs(b));
    expect(compareEpochNs(a, b)).toBeLessThan(0);
    expect(compareEpochNs(a, a)).toBe(0);
  });

  test('different string lengths compare numerically, not lexicographically', () => {
    expect(compareEpochNs(ns('999'), ns('1000'))).toBeLessThan(0);
  });

  test('sorting is deterministic and agrees with BigInt order', () => {
    const values = [
      '1773063000000000010',
      '999',
      '1773063000000000009',
      '1773062999999999999',
      '0',
    ] as EpochNs[];
    const sorted = [...values].sort(compareEpochNs);
    expect(sorted).toEqual(
      [...values].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)),
    );
  });

  test('identical ns: ingestSeq breaks the tie', () => {
    const time = { ns: ns('1773063000000000001'), ms: 1773063000000 };
    expect(compareTradeOrder({ time, ingestSeq: 4 }, { time, ingestSeq: 9 })).toBeLessThan(0);
    expect(compareTradeOrder({ time, ingestSeq: 9 }, { time, ingestSeq: 4 })).toBeGreaterThan(0);
    expect(compareTradeOrder({ time, ingestSeq: 4 }, { time, ingestSeq: 4 })).toBe(0);
  });
});
