/**
 * IndicatorSeries: the runtime of one indicator instance over a growing/changing bar array.
 *
 * It tracks how many leading bar positions have correct outputs (`validLength`). Data changes
 * lower that mark (`invalidateFrom`: a bar at that position or later changed; `reset`: everything
 * changed, e.g. new data or bars shifted by a prepend); `update` recomputes only the suffix
 * [validLength, bars.length). Recursive indicators therefore recompute from the earliest affected
 * bar forward, and an appended live bar costs one value, not the whole history.
 */
import type { IndicatorBar, IndicatorCalculator, IndicatorDefinition } from './definition.ts';
import { grow } from './definition.ts';

export class IndicatorSeries {
  private readonly calculator: IndicatorCalculator;
  private outputs: Float64Array<ArrayBuffer>[];
  private valid = 0;
  private count = 0;

  constructor(
    readonly definition: IndicatorDefinition,
    readonly params: Readonly<Record<string, number>>,
  ) {
    this.calculator = definition.createCalculator(params);
    this.outputs = definition.outputs.map(() => new Float64Array(0));
  }

  /** Bars at `index` and later changed or were inserted: their outputs must be recomputed. */
  invalidateFrom(index: number): void {
    this.valid = Math.max(0, Math.min(this.valid, index));
  }

  /** Every output is stale (new data, or positions shifted by older bars). */
  reset(): void {
    this.valid = 0;
    this.count = 0;
  }

  /** Recomputes the stale suffix. Returns the first position that was recomputed. */
  update(bars: readonly IndicatorBar[]): number {
    const from = Math.min(this.valid, bars.length);
    if (bars.length > this.outputs[0]!.length) {
      this.outputs = this.outputs.map((o) => grow(o, bars.length));
      this.calculator.ensureCapacity(bars.length);
    }
    if (from < bars.length) this.calculator.update(bars, from, this.outputs);
    this.valid = bars.length;
    this.count = bars.length;
    return from;
  }

  /** Positions with outputs (the bar count at the last update). */
  get length(): number {
    return this.count;
  }

  /** Leading positions whose outputs are up to date. */
  get validLength(): number {
    return this.valid;
  }

  /** Output `output` at bar position `index`, or null for no value / out of range. */
  value(output: number, index: number): number | null {
    if (index < 0 || index >= this.count) return null;
    const v = this.outputs[output]?.[index];
    return v !== undefined && Number.isFinite(v) ? v : null;
  }

  /** Raw values of one output (NaN = no value); positions >= length are meaningless. */
  values(output: number): Float64Array {
    return this.outputs[output]!;
  }
}

/** One-shot full calculation (tests, server-side use): outputs[outputKey] = values or null. */
export function calculateIndicator(
  definition: IndicatorDefinition,
  params: Readonly<Record<string, number>>,
  bars: readonly IndicatorBar[],
): Record<string, (number | null)[]> {
  const series = new IndicatorSeries(definition, params);
  series.update(bars);
  const result: Record<string, (number | null)[]> = {};
  definition.outputs.forEach((o, k) => {
    result[o.key] = bars.map((_, i) => series.value(k, i));
  });
  return result;
}
