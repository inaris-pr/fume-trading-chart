/**
 * SMA and EMA (price overlays) on the bar closes.
 *
 * SMA(n)[i] = (close[i-n+1] + … + close[i]) / n for i >= n-1; no value before.
 *   The window sum is carried forward (sum[i] = sum[i-1] + close[i] - close[i-n]) and re-summed
 *   from scratch every SMA_RESYNC values (and at the first value) to bound floating-point drift.
 *   Both rules depend only on the index, so incremental and full calculations agree exactly.
 *
 * EMA(n): alpha = 2 / (n + 1); seed EMA[n-1] = SMA(n)[n-1] (the plain average of the first n
 *   closes); EMA[i] = EMA[i-1] + alpha * (close[i] - EMA[i-1]) for i >= n; no value before n-1.
 */
import {
  finiteOrNaN,
  grow,
  type IndicatorBar,
  type IndicatorCalculator,
  type IndicatorDefinition,
  type IndicatorParamSpec,
} from '../definition.ts';

/** Re-sum an SMA window from scratch every this many values (index-based, deterministic). */
export const SMA_RESYNC = 512;

const period = (fallback: number): IndicatorParamSpec => ({
  key: 'period',
  label: 'Period',
  kind: 'integer',
  min: 1,
  max: 1000,
  default: fallback,
});

class SmaCalculator implements IndicatorCalculator {
  private sums = new Float64Array(0);
  constructor(private readonly n: number) {}

  ensureCapacity(capacity: number): void {
    this.sums = grow(this.sums, capacity);
  }

  update(bars: readonly IndicatorBar[], from: number, outputs: readonly Float64Array[]): void {
    const out = outputs[0]!;
    const n = this.n;
    for (let i = from; i < bars.length; i++) {
      if (i < n - 1) {
        out[i] = Number.NaN;
        this.sums[i] = Number.NaN;
        continue;
      }
      let sum: number;
      if (i === n - 1 || (i - (n - 1)) % SMA_RESYNC === 0) {
        sum = 0;
        for (let k = i - n + 1; k <= i; k++) sum += bars[k]!.close;
      } else {
        sum = this.sums[i - 1]! + bars[i]!.close - bars[i - n]!.close;
      }
      this.sums[i] = sum;
      out[i] = finiteOrNaN(sum / n);
    }
  }
}

class EmaCalculator implements IndicatorCalculator {
  constructor(private readonly n: number) {}

  ensureCapacity(): void {}

  update(bars: readonly IndicatorBar[], from: number, outputs: readonly Float64Array[]): void {
    const out = outputs[0]!;
    const n = this.n;
    const alpha = 2 / (n + 1);
    for (let i = from; i < bars.length; i++) {
      if (i < n - 1) {
        out[i] = Number.NaN;
      } else if (i === n - 1) {
        let sum = 0;
        for (let k = 0; k < n; k++) sum += bars[k]!.close;
        out[i] = finiteOrNaN(sum / n);
      } else {
        const prev = out[i - 1]!;
        out[i] = finiteOrNaN(prev + alpha * (bars[i]!.close - prev));
      }
    }
  }
}

export const SMA: IndicatorDefinition = {
  type: 'sma',
  name: 'Simple Moving Average',
  placement: 'overlay',
  params: [period(20)],
  style: [
    { key: 'color', label: 'Color', kind: 'color', default: '#f5a623' },
    { key: 'lineWidth', label: 'Width', kind: 'lineWidth', default: 1.5 },
  ],
  outputs: [{ key: 'value', label: 'SMA', plot: 'line', color: 'color', lineWidth: 'lineWidth' }],
  scale: { kind: 'price' },
  guides: [],
  valueFormat: 'price',
  label: (p) => `SMA ${p.period}`,
  createCalculator: (p) => new SmaCalculator(p.period!),
};

export const EMA: IndicatorDefinition = {
  type: 'ema',
  name: 'Exponential Moving Average',
  placement: 'overlay',
  params: [period(20)],
  style: [
    { key: 'color', label: 'Color', kind: 'color', default: '#2ec4d6' },
    { key: 'lineWidth', label: 'Width', kind: 'lineWidth', default: 1.5 },
  ],
  outputs: [{ key: 'value', label: 'EMA', plot: 'line', color: 'color', lineWidth: 'lineWidth' }],
  scale: { kind: 'price' },
  guides: [],
  valueFormat: 'price',
  label: (p) => `EMA ${p.period}`,
  createCalculator: (p) => new EmaCalculator(p.period!),
};
