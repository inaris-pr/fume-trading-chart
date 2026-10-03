/**
 * @fume/indicators public entry (docs/indicators.md): indicator definitions, the registry, the
 * versioned instance schema and incremental calculations. Pure: no DOM, no Canvas, no framework,
 * no provider code, no runtime dependencies.
 */
export type {
  IndicatorBar,
  IndicatorCalculator,
  IndicatorDefinition,
  IndicatorOutputSpec,
  IndicatorParamSpec,
  IndicatorPlacement,
  IndicatorScale,
  IndicatorStyleSpec,
  IndicatorValueFormat,
} from './definition.ts';
export { EMA, SMA, SMA_RESYNC } from './builtin/moving-averages.ts';
export { RSI, VOLUME } from './builtin/oscillators.ts';
export { BUILTIN_INDICATORS, builtinIndicators, IndicatorRegistry } from './registry.ts';
export {
  applyIndicatorPatch,
  createIndicator,
  INDICATOR_DOCUMENT_FORMAT,
  INDICATOR_SCHEMA_VERSION,
  IndicatorSchemaError,
  normalizeIndicator,
  parseIndicatorDocument,
  serializeIndicators,
  type IndicatorChange,
  type IndicatorDocument,
  type IndicatorInstance,
  type IndicatorPatch,
} from './model.ts';
export { calculateIndicator, IndicatorSeries } from './series.ts';
