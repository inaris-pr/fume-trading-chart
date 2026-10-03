/**
 * Volume and RSI (separate panes).
 *
 * Volume[i] = volume[i] of the displayed (canonical) bar, unchanged. Histogram colored by the
 *   bar's direction (close >= open: up color, else down color). Pane scale: 0 .. visible max.
 *
 * RSI(n), Wilder: change[i] = close[i] - close[i-1]; gain = max(change, 0), loss = max(-change, 0).
 *   Seed at i = n: avgGain[n] = (gain[1] + … + gain[n]) / n, avgLoss[n] likewise (needs n changes,
 *   i.e. n + 1 bars). Then avgGain[i] = (avgGain[i-1] * (n-1) + gain[i]) / n (same for loss).
 *   RSI[i] from the two averages (at the seed and at every recursive step alike):
 *     avgGain > 0, avgLoss = 0: 100 (only gains)
 *     avgGain = 0, avgLoss > 0: 0 (only losses)
 *     avgGain = 0, avgLoss = 0: 50 (no movement at all: neutral)
 *     otherwise: 100 - 100 / (1 + avgGain / avgLoss)
 *   No value before i = n. Fixed 0..100 scale with guides at 30 and 70.
 */
import {
  finiteOrNaN,
  grow,
  type IndicatorBar,
  type IndicatorCalculator,
  type IndicatorDefinition,
} from '../definition.ts';

class VolumeCalculator implements IndicatorCalculator {
  ensureCapacity(): void {}

  update(bars: readonly IndicatorBar[], from: number, outputs: readonly Float64Array[]): void {
    const out = outputs[0]!;
    for (let i = from; i < bars.length; i++) out[i] = finiteOrNaN(bars[i]!.volume);
  }
}

/** The zero cases are decided explicitly, so nothing is ever divided by zero. */
function rsiFromAverages(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

class RsiCalculator implements IndicatorCalculator {
  private avgGain = new Float64Array(0);
  private avgLoss = new Float64Array(0);
  constructor(private readonly n: number) {}

  ensureCapacity(capacity: number): void {
    this.avgGain = grow(this.avgGain, capacity);
    this.avgLoss = grow(this.avgLoss, capacity);
  }

  update(bars: readonly IndicatorBar[], from: number, outputs: readonly Float64Array[]): void {
    const out = outputs[0]!;
    const n = this.n;
    for (let i = from; i < bars.length; i++) {
      if (i < n) {
        out[i] = Number.NaN;
        this.avgGain[i] = Number.NaN;
        this.avgLoss[i] = Number.NaN;
        continue;
      }
      let gain: number;
      let loss: number;
      if (i === n) {
        let g = 0;
        let l = 0;
        for (let k = 1; k <= n; k++) {
          const change = bars[k]!.close - bars[k - 1]!.close;
          if (change > 0) g += change;
          else l -= change;
        }
        gain = g / n;
        loss = l / n;
      } else {
        const change = bars[i]!.close - bars[i - 1]!.close;
        gain = (this.avgGain[i - 1]! * (n - 1) + Math.max(change, 0)) / n;
        loss = (this.avgLoss[i - 1]! * (n - 1) + Math.max(-change, 0)) / n;
      }
      this.avgGain[i] = gain;
      this.avgLoss[i] = loss;
      out[i] = finiteOrNaN(rsiFromAverages(gain, loss));
    }
  }
}

export const VOLUME: IndicatorDefinition = {
  type: 'volume',
  name: 'Volume',
  placement: 'pane',
  params: [],
  style: [
    { key: 'upColor', label: 'Up', kind: 'color', default: 'rgba(38, 178, 122, 0.55)' },
    { key: 'downColor', label: 'Down', kind: 'color', default: 'rgba(226, 72, 77, 0.55)' },
  ],
  outputs: [
    {
      key: 'volume',
      label: 'Vol',
      plot: 'histogram',
      color: 'upColor',
      directionColors: { up: 'upColor', down: 'downColor' },
    },
  ],
  scale: { kind: 'auto', includeZero: true },
  guides: [],
  valueFormat: 'volume',
  label: () => 'Volume',
  createCalculator: () => new VolumeCalculator(),
};

export const RSI: IndicatorDefinition = {
  type: 'rsi',
  name: 'Relative Strength Index',
  placement: 'pane',
  params: [{ key: 'period', label: 'Period', kind: 'integer', min: 1, max: 500, default: 14 }],
  style: [
    { key: 'color', label: 'Color', kind: 'color', default: '#b36bff' },
    { key: 'lineWidth', label: 'Width', kind: 'lineWidth', default: 1.5 },
  ],
  outputs: [{ key: 'value', label: 'RSI', plot: 'line', color: 'color', lineWidth: 'lineWidth' }],
  scale: { kind: 'fixed', min: 0, max: 100 },
  guides: [30, 70],
  valueFormat: 'number',
  label: (p) => `RSI ${p.period}`,
  createCalculator: (p) => new RsiCalculator(p.period!),
};
