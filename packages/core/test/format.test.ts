import { describe, expect, test } from 'vitest';
import { createPriceFormatter, createTimeFormatter, tickSizeAt } from '../src/format.ts';

describe('createPriceFormatter (decimal)', () => {
  const two = createPriceFormatter({ kind: 'decimal', decimals: 2 });

  test('fixed decimals from metadata, no currency symbol', () => {
    expect(two(574.25)).toBe('574.25');
    expect(two(574.2)).toBe('574.20');
    expect(two(5000)).toBe('5000.00');
  });

  test('negative values and negative zero', () => {
    expect(two(-3.456)).toBe('-3.46');
    expect(two(-0)).toBe('0.00');
    expect(two(-0.001)).toBe('0.00');
  });

  test('floating-point noise from grid arithmetic is hidden', () => {
    expect(two(0.1 * 3)).toBe('0.30');
    expect(two(574 + 0.1 + 0.2)).toBe('574.30');
  });

  test('sub-penny precision', () => {
    expect(createPriceFormatter({ kind: 'decimal', decimals: 4 })(0.0142)).toBe('0.0142');
  });

  test('rejects nonsense precision', () => {
    expect(() => createPriceFormatter({ kind: 'decimal', decimals: -1 })).toThrow();
  });
});

describe('createPriceFormatter (fraction)', () => {
  test('32nds', () => {
    const f = createPriceFormatter({ kind: 'fraction', denominator: 32 });
    expect(f(112.5)).toBe("112'16");
    expect(f(112 + 3 / 32)).toBe("112'03");
    expect(f(-0.5)).toBe("-0'16");
  });

  test('halves of 32nds', () => {
    const f = createPriceFormatter({ kind: 'fraction', denominator: 32, subDenominator: 2 });
    expect(f(110 + 7.5 / 32)).toBe("110'071");
  });
});

describe('tickSizeAt', () => {
  const rules = [
    { fromPrice: '1', tickSize: '0.01' },
    { fromPrice: '0', tickSize: '0.0001' },
  ];
  test('price-dependent rules, order independent', () => {
    expect(tickSizeAt(rules, 574.25)).toBe(0.01);
    expect(tickSizeAt(rules, 1)).toBe(0.01);
    expect(tickSizeAt(rules, 0.5)).toBe(0.0001);
  });
  test('negative prices use the absolute value', () => {
    expect(tickSizeAt(rules, -3)).toBe(0.01);
  });
  test('no rules is an error', () => {
    expect(() => tickSizeAt([], 1)).toThrow();
  });
});

describe('createTimeFormatter', () => {
  const instant = Date.UTC(2026, 2, 9, 13, 30); // 09:30 New York (EDT)

  test('labels in the instrument time zone', () => {
    const ny = createTimeFormatter('America/New_York');
    expect(ny(instant, 'time')).toBe('09:30');
    expect(ny(instant, 'day')).toBe('Mar 9');
    expect(ny(instant, 'month')).toBe('Mar');
    expect(ny(instant, 'year')).toBe('2026');
  });

  test('the same instant in a second zone', () => {
    const tokyo = createTimeFormatter('Asia/Tokyo');
    expect(tokyo(instant, 'time')).toBe('22:30');
    const london = createTimeFormatter('Europe/London');
    expect(london(instant, 'time')).toBe('13:30'); // UK still on GMT on 2026-03-09
  });
});
