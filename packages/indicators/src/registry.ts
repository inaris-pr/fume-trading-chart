/**
 * Indicator registry: the definitions an engine knows, looked up by type. Engines never switch on
 * indicator types; they read definitions. Stage 9 ships the built-ins only (no user scripts).
 */
import { EMA, SMA } from './builtin/moving-averages.ts';
import { RSI, VOLUME } from './builtin/oscillators.ts';
import type { IndicatorDefinition } from './definition.ts';

export class IndicatorRegistry {
  private readonly byType = new Map<string, IndicatorDefinition>();

  constructor(definitions: readonly IndicatorDefinition[]) {
    for (const d of definitions) {
      if (this.byType.has(d.type)) throw new Error(`Duplicate indicator type ${d.type}`);
      if ((d.placement === 'overlay') !== (d.scale.kind === 'price'))
        throw new Error(`${d.type}: overlays (and only overlays) use the price scale`);
      if (d.outputs.length === 0) throw new Error(`${d.type}: at least one output`);
      const styleKeys = new Set(d.style.map((s) => s.key));
      for (const o of d.outputs) {
        const keys = [o.color, o.lineWidth, o.directionColors?.up, o.directionColors?.down];
        for (const k of keys)
          if (k !== undefined && !styleKeys.has(k))
            throw new Error(`${d.type}.${o.key}: unknown style key ${k}`);
      }
      this.byType.set(d.type, d);
    }
  }

  get(type: string): IndicatorDefinition | undefined {
    return this.byType.get(type);
  }

  list(): readonly IndicatorDefinition[] {
    return [...this.byType.values()];
  }
}

/** Built-in definitions in display order. */
export const BUILTIN_INDICATORS: readonly IndicatorDefinition[] = [SMA, EMA, VOLUME, RSI];

export const builtinIndicators = new IndicatorRegistry(BUILTIN_INDICATORS);
