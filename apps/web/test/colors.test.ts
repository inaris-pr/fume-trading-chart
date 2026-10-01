import { describe, expect, test } from 'vitest';
import { opaqueHex, parseColor, rgbaString, withAlpha } from '../src/colors.ts';

describe('drawing color helpers', () => {
  test('parses hex and rgb(a)', () => {
    expect(parseColor('#5b8cff')).toEqual({ r: 91, g: 140, b: 255, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(91, 140, 255, 0.12)')).toEqual({ r: 91, g: 140, b: 255, a: 0.12 });
    expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('blue')).toBeNull();
  });

  test('alpha round-trip keeps the RGB (fill opacity without a schema change)', () => {
    expect(withAlpha('#e2484d', 0.35)).toBe('rgba(226, 72, 77, 0.35)');
    expect(withAlpha('rgba(226, 72, 77, 0.35)', 0)).toBe('rgba(226, 72, 77, 0)');
    expect(rgbaString({ r: 1, g: 2, b: 3, a: 0.333333 })).toBe('rgba(1, 2, 3, 0.33)');
    expect(opaqueHex('rgba(91, 140, 255, 0.12)')).toBe('#5b8cff');
    expect(withAlpha('blue', 0.5)).toBe('blue');
  });
});
