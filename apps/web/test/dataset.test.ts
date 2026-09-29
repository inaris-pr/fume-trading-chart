import { describe, expect, test } from 'vitest';
import { buildDemoDataset, DEMO_BAR_COUNT } from '../src/demo/dataset.ts';

describe('demo datasets', () => {
  test.each([500, 1_000, 10_000])(
    '%d bars: deterministic, fully mappable, one deliberate gap',
    (count) => {
      const a = buildDemoDataset('spy', count);
      const b = buildDemoDataset('spy', count);
      expect(a.bars).toEqual(b.bars);
      expect(a.bars).toHaveLength(count - 1);
      const slots = a.bars.map((bar) => a.timeScale.toSlot(bar.start));
      expect(slots.every((s) => s !== null && Number.isInteger(s))).toBe(true);
      const gaps = slots.slice(1).filter((s, i) => s! - slots[i]! !== 1);
      expect(gaps).toHaveLength(1);
    },
  );

  test('default demo: SPY, 5m, 779 bars starting 2026-03-02 09:30 ET', () => {
    const d = buildDemoDataset('spy', DEMO_BAR_COUNT);
    expect(d.instrument.displaySymbol).toBe('SPY');
    expect(d.bars[0]!.start).toBe(Date.UTC(2026, 2, 2, 14, 30));
    expect(d.minPriceStep).toBe(0.01);
    expect(d.formatPrice(d.bars[0]!.open)).toBe('574.25');
  });

  test('edge-case scenarios', () => {
    const flat = buildDemoDataset('flat', 200);
    expect(new Set(flat.bars.flatMap((b) => [b.open, b.high, b.low, b.close])).size).toBe(1);
    const neg = buildDemoDataset('negative', DEMO_BAR_COUNT);
    const recent = neg.bars.slice(-120);
    expect(recent.some((b) => b.close > 0) && recent.some((b) => b.close < 0)).toBe(true);
    expect(neg.formatPrice(-1.5)).toBe('-1.50');
    const sub = buildDemoDataset('subpenny', DEMO_BAR_COUNT);
    expect(sub.minPriceStep).toBe(0.0001);
    expect(sub.formatPrice(sub.bars[0]!.open)).toMatch(/^0\.\d{4}$/);
  });
});
