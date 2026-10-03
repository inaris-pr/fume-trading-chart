/**
 * ChartIndicators: the chart's indicator engine (docs/indicators.md). Owns the indicator instances
 * of one chart and one incremental IndicatorSeries per instance; turns data events into suffix
 * invalidation; assigns panes; answers the frame's range questions; produces plot and legend data.
 * Framework-free; React and hosts only pass configuration in and receive change events.
 *
 * Two write paths (same rule as drawings): host replacement (setIndicators: not echoed) and user
 * commands (add / update / remove: reported through onChange). No undo for indicators.
 */
import {
  applyIndicatorPatch,
  builtinIndicators,
  createIndicator,
  IndicatorSeries,
  normalizeIndicator,
  type IndicatorBar,
  type IndicatorChange,
  type IndicatorDefinition,
  type IndicatorInstance,
  type IndicatorPatch,
} from '@fume/indicators';
import type { PaneScaleSpec } from '../frame.ts';
import type { PriceRange } from '../price-scale.ts';
import { formatAxisValue, formatLegendValue } from './format.ts';

interface Runtime {
  instance: IndicatorInstance;
  definition: IndicatorDefinition;
  series: IndicatorSeries;
}

/** One painted series: a line or histogram on a pane (0 = main price pane). */
export interface IndicatorPlot {
  pane: number;
  kind: 'line' | 'histogram';
  /** Values by bar position (NaN = no value). */
  values: Float64Array;
  /** Positions [0, length) are valid. */
  length: number;
  color: string;
  lineWidth: number;
  /** Histogram colored by the candle direction (close >= open: up). */
  directionColors?: { up: string; down: string };
}

/** One legend row: an indicator's label and its output values at one bar. */
export interface IndicatorLegendRow {
  pane: number;
  label: string;
  values: { text: string; color: string }[];
}

export interface ChartIndicatorsOptions {
  createId: () => string;
  onChange?: (indicators: readonly IndicatorInstance[], change: IndicatorChange) => void;
  /** The indicator configuration changed: the main layer (and maybe the layout) must repaint. */
  onInvalidate?: () => void;
}

const NO_VALUE = '—';

export class ChartIndicators {
  private list: readonly IndicatorInstance[] = [];
  private runtimes = new Map<string, Runtime>();
  private options: ChartIndicatorsOptions | null;

  constructor(options: ChartIndicatorsOptions) {
    this.options = options;
  }

  // --- configuration ---------------------------------------------------------------------------

  getIndicators(): readonly IndicatorInstance[] {
    return this.list;
  }

  /**
   * Host replacement (configuration from the host's state or storage); not reported back.
   * Invalid instances are left out (they cannot be calculated); the array is kept as given when
   * every instance is valid. Unchanged instances keep their calculated values.
   */
  setIndicators(list: readonly IndicatorInstance[]): void {
    if (list === this.list) return;
    const valid: IndicatorInstance[] = [];
    const ids = new Set<string>();
    for (const raw of list) {
      try {
        const instance = normalizeIndicator(raw);
        if (ids.has(instance.id)) continue;
        ids.add(instance.id);
        valid.push(instance);
      } catch {
        // Invalid configuration from the host: skipped, never guessed.
      }
    }
    this.list =
      valid.length === list.length && valid.every((v, i) => same(v, list[i]!)) ? list : valid;
    this.rebuildRuntimes();
    this.options?.onInvalidate?.();
  }

  /** User command: adds an instance of `type` (defaults + options). Returns its id or null. */
  add(type: string, options: IndicatorPatch = {}): string | null {
    let instance: IndicatorInstance;
    try {
      instance = createIndicator(type, this.options?.createId() ?? defaultIndicatorId(), options);
    } catch {
      return null;
    }
    if (this.runtimes.has(instance.id)) return null;
    this.commit([...this.list, instance], { kind: 'add', id: instance.id });
    return instance.id;
  }

  /** User command: edits params / style / visibility. False for unknown ids or invalid patches. */
  update(id: string, patch: IndicatorPatch): boolean {
    const current = this.runtimes.get(id)?.instance;
    if (!current) return false;
    const next = applyIndicatorPatch(current, patch);
    if (!next || next === current) return false;
    this.commit(
      this.list.map((i) => (i.id === id ? next : i)),
      { kind: 'update', id },
    );
    return true;
  }

  /** User command: removes an instance. */
  remove(id: string): boolean {
    if (!this.runtimes.has(id)) return false;
    this.commit(
      this.list.filter((i) => i.id !== id),
      { kind: 'remove', id },
    );
    return true;
  }

  dispose(): void {
    this.options = null;
  }

  // --- data lifecycle --------------------------------------------------------------------------

  /** New series (symbol/timeframe switch) or bar positions shifted (older history): recompute all. */
  resetData(): void {
    for (const r of this.runtimes.values()) r.series.reset();
  }

  /** Bars at `index` and later changed (live update, correction, gap fill). */
  barsChangedFrom(index: number): void {
    for (const r of this.runtimes.values()) r.series.invalidateFrom(index);
  }

  /** Recomputes the stale suffix of every VISIBLE indicator (hidden ones catch up when shown). */
  sync(bars: readonly IndicatorBar[]): void {
    for (const r of this.runtimes.values()) if (r.instance.visible) r.series.update(bars);
  }

  // --- frame & painting (after sync) ---------------------------------------------------------

  /** Visible pane indicators in configuration order; pane k + 1 (below the main pane). */
  paneRuntimes(): Runtime[] {
    return this.visible().filter((r) => r.definition.placement === 'pane');
  }

  /** Finite min/max of visible price-overlay values over bars [from, to). */
  overlayRange(from: number, to: number): PriceRange | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const r of this.visible()) {
      if (r.definition.placement !== 'overlay') continue;
      for (let k = 0; k < r.definition.outputs.length; k++) {
        const values = r.series.values(k);
        const end = Math.min(to, r.series.length);
        for (let i = Math.max(0, from); i < end; i++) {
          const v = values[i]!;
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    return min <= max ? { min, max } : null;
  }

  /** Scale of indicator pane `pane` over bars [from, to). */
  paneScale(pane: number, from: number, to: number, formatPrice: (p: number) => string) {
    const r = this.paneRuntimes()[pane];
    if (!r) return null;
    const format = (v: number) => formatAxisValue(r.definition.valueFormat, v, formatPrice);
    const { scale, guides } = r.definition;
    if (scale.kind === 'fixed') {
      return {
        kind: 'fixed',
        range: { min: scale.min, max: scale.max },
        guides,
        format,
      } satisfies PaneScaleSpec;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < r.definition.outputs.length; k++) {
      const values = r.series.values(k);
      const end = Math.min(to, r.series.length);
      for (let i = Math.max(0, from); i < end; i++) {
        const v = values[i]!;
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return {
      kind: 'auto',
      includeZero: scale.kind === 'auto' && scale.includeZero,
      range: min <= max ? { min, max } : null,
      guides,
      format,
    } satisfies PaneScaleSpec;
  }

  /** Paint data for every visible indicator output, overlays first, then panes in order. */
  plots(): IndicatorPlot[] {
    const plots: IndicatorPlot[] = [];
    const panes = this.paneRuntimes();
    for (const r of this.visible()) {
      const pane = r.definition.placement === 'overlay' ? 0 : panes.indexOf(r) + 1;
      r.definition.outputs.forEach((o, k) => {
        const s = r.instance.style;
        plots.push({
          pane,
          kind: o.plot,
          values: r.series.values(k),
          length: r.series.length,
          color: String(s[o.color]),
          lineWidth: o.lineWidth !== undefined ? Number(s[o.lineWidth]) : 1,
          ...(o.directionColors
            ? {
                directionColors: {
                  up: String(s[o.directionColors.up]),
                  down: String(s[o.directionColors.down]),
                },
              }
            : {}),
        });
      });
    }
    return plots;
  }

  /** Legend rows for bar position `index` (null: no bar there, e.g. a crosshair on a gap). */
  legend(
    index: number | null,
    bars: readonly IndicatorBar[],
    formatPrice: (p: number) => string,
  ): IndicatorLegendRow[] {
    const panes = this.paneRuntimes();
    const bar = index === null ? undefined : bars[index];
    return this.visible().map((r) => ({
      pane: r.definition.placement === 'overlay' ? 0 : panes.indexOf(r) + 1,
      label: r.definition.label(r.instance.params),
      values: r.definition.outputs.map((o, k) => {
        const v = index === null ? null : r.series.value(k, index);
        const s = r.instance.style;
        const color =
          o.directionColors && bar
            ? String(s[bar.close >= bar.open ? o.directionColors.up : o.directionColors.down])
            : String(s[o.color]);
        return {
          text: v === null ? NO_VALUE : formatLegendValue(r.definition.valueFormat, v, formatPrice),
          color,
        };
      }),
    }));
  }

  /** Output values of one visible indicator at bar position `index`, or null. */
  valuesAt(id: string, index: number): Record<string, number | null> | null {
    const r = this.runtimes.get(id);
    if (!r || !r.instance.visible) return null;
    const out: Record<string, number | null> = {};
    r.definition.outputs.forEach((o, k) => (out[o.key] = r.series.value(k, index)));
    return out;
  }

  // ---------------------------------------------------------------------------------------------

  private visible(): Runtime[] {
    const out: Runtime[] = [];
    for (const i of this.list) {
      const r = this.runtimes.get(i.id);
      if (r && i.visible) out.push(r);
    }
    return out;
  }

  private commit(next: readonly IndicatorInstance[], change: IndicatorChange): void {
    this.list = next;
    this.rebuildRuntimes();
    this.options?.onChange?.(next, change);
    this.options?.onInvalidate?.();
  }

  /** Keeps a runtime (and its values) while type and params are unchanged; style is paint-only. */
  private rebuildRuntimes(): void {
    const next = new Map<string, Runtime>();
    for (const instance of this.list) {
      const old = this.runtimes.get(instance.id);
      const definition = builtinIndicators.get(instance.type)!;
      if (old && old.instance.type === instance.type && sameParams(old.instance, instance)) {
        next.set(instance.id, { instance, definition, series: old.series });
      } else {
        next.set(instance.id, {
          instance,
          definition,
          series: new IndicatorSeries(definition, instance.params),
        });
      }
    }
    this.runtimes = next;
  }
}

function sameParams(a: IndicatorInstance, b: IndicatorInstance): boolean {
  const keys = Object.keys(a.params);
  return (
    keys.length === Object.keys(b.params).length && keys.every((k) => a.params[k] === b.params[k])
  );
}

function same(a: IndicatorInstance, b: IndicatorInstance): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.visible === b.visible &&
    sameParams(a, b) &&
    Object.keys(a.style).length === Object.keys(b.style).length &&
    Object.keys(a.style).every((k) => a.style[k] === b.style[k])
  );
}

let fallbackCounter = 0;

/** `ind-` + crypto.randomUUID() where available, else a time + counter id. */
export function defaultIndicatorId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `ind-${uuid ?? `${Date.now().toString(36)}-${(fallbackCounter++).toString(36)}`}`;
}
