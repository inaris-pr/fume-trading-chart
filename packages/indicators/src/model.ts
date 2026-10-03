/**
 * Indicator instances (docs/indicators.md): plain, serializable configuration. Computed values,
 * pixel positions, viewport state and bar indexes are runtime data and are never persisted.
 * The host owns persistence (serializeIndicators / parseIndicatorDocument).
 */
import type { IndicatorDefinition } from './definition.ts';
import { builtinIndicators, type IndicatorRegistry } from './registry.ts';

/** Bumped on any incompatible change to the persisted shape; parse rejects unknown versions. */
export const INDICATOR_SCHEMA_VERSION = 1;
export const INDICATOR_DOCUMENT_FORMAT = 'fume.indicators';

export interface IndicatorInstance {
  /** Unique within one chart's indicator set. */
  id: string;
  /** A registered definition type (`sma`, `ema`, `volume`, `rsi`). */
  type: string;
  /** Every parameter of the definition, validated (integers within the declared range). */
  params: Readonly<Record<string, number>>;
  /** Every style field of the definition (colors, line widths). */
  style: Readonly<Record<string, string | number>>;
  /** Hidden indicators are not calculated, painted or given a pane. */
  visible: boolean;
}

export interface IndicatorDocument {
  format: typeof INDICATOR_DOCUMENT_FORMAT;
  version: typeof INDICATOR_SCHEMA_VERSION;
  indicators: IndicatorInstance[];
}

/** What a user action changed (reported with the complete new indicator set). */
export interface IndicatorChange {
  kind: 'add' | 'update' | 'remove';
  id: string;
}

/** A user edit of an existing instance; omitted fields stay as they are. */
export interface IndicatorPatch {
  params?: Readonly<Record<string, number>>;
  style?: Readonly<Record<string, string | number>>;
  visible?: boolean;
}

export class IndicatorSchemaError extends Error {
  override readonly name = 'IndicatorSchemaError';
}

/**
 * Validates and normalizes one instance: every field present, keys in definition order, defaults
 * for missing params/style fields. Unknown types, unknown keys, non-integer or out-of-range
 * params, empty colors and invalid widths are rejected (never guessed or clamped).
 */
export function normalizeIndicator(
  raw: unknown,
  registry: IndicatorRegistry = builtinIndicators,
): IndicatorInstance {
  if (!isRecord(raw)) throw new IndicatorSchemaError('indicator is not an object');
  const { id, type, params, style, visible } = raw;
  if (typeof id !== 'string' || id.length === 0)
    throw new IndicatorSchemaError('id must be a non-empty string');
  if (typeof type !== 'string') throw new IndicatorSchemaError(`${id}: type must be a string`);
  const definition = registry.get(type);
  if (!definition) throw new IndicatorSchemaError(`${id}: unknown indicator type ${type}`);
  if (visible !== undefined && typeof visible !== 'boolean')
    throw new IndicatorSchemaError(`${id}: visible must be a boolean`);
  return {
    id,
    type,
    params: normalizeParams(definition, params ?? {}, id),
    style: normalizeStyle(definition, style ?? {}, id),
    visible: visible ?? true,
  };
}

/** A new instance of `type` with defaults, overridden by `options` (validated). */
export function createIndicator(
  type: string,
  id: string,
  options: IndicatorPatch = {},
  registry: IndicatorRegistry = builtinIndicators,
): IndicatorInstance {
  return normalizeIndicator(
    { id, type, params: options.params, style: options.style, visible: options.visible },
    registry,
  );
}

/**
 * The instance with `patch` applied and validated; the same object when nothing changes; null for
 * an invalid patch (unknown key, bad value).
 */
export function applyIndicatorPatch(
  instance: IndicatorInstance,
  patch: IndicatorPatch,
  registry: IndicatorRegistry = builtinIndicators,
): IndicatorInstance | null {
  let next: IndicatorInstance;
  try {
    next = normalizeIndicator(
      {
        id: instance.id,
        type: instance.type,
        params: { ...instance.params, ...patch.params },
        style: { ...instance.style, ...patch.style },
        visible: patch.visible ?? instance.visible,
      },
      registry,
    );
  } catch {
    return null;
  }
  return sameConfig(instance, next) ? instance : next;
}

/** Canonical persisted form: fixed key order, configuration only. */
export function serializeIndicators(
  indicators: readonly IndicatorInstance[],
  registry: IndicatorRegistry = builtinIndicators,
): IndicatorDocument {
  return {
    format: INDICATOR_DOCUMENT_FORMAT,
    version: INDICATOR_SCHEMA_VERSION,
    indicators: indicators.map((i) => normalizeIndicator(i, registry)),
  };
}

/** Validates untrusted persisted data. Throws IndicatorSchemaError; nothing is silently dropped. */
export function parseIndicatorDocument(
  value: unknown,
  registry: IndicatorRegistry = builtinIndicators,
): IndicatorInstance[] {
  if (!isRecord(value) || value.format !== INDICATOR_DOCUMENT_FORMAT)
    throw new IndicatorSchemaError('Not a Fume indicator document');
  if (value.version !== INDICATOR_SCHEMA_VERSION)
    throw new IndicatorSchemaError(`Unsupported indicator schema version ${String(value.version)}`);
  if (!Array.isArray(value.indicators))
    throw new IndicatorSchemaError('indicators must be an array');
  const ids = new Set<string>();
  return value.indicators.map((raw) => {
    if (isRecord(raw) && typeof raw.visible !== 'boolean')
      throw new IndicatorSchemaError(`${String(raw.id)}: visible must be a boolean`);
    const instance = normalizeIndicator(raw, registry);
    if (ids.has(instance.id))
      throw new IndicatorSchemaError(`Duplicate indicator id ${instance.id}`);
    ids.add(instance.id);
    return instance;
  });
}

function normalizeParams(
  definition: IndicatorDefinition,
  raw: unknown,
  id: string,
): Record<string, number> {
  if (!isRecord(raw)) throw new IndicatorSchemaError(`${id}: params must be an object`);
  const known = new Set(definition.params.map((p) => p.key));
  for (const key of Object.keys(raw))
    if (!known.has(key)) throw new IndicatorSchemaError(`${id}: unknown parameter ${key}`);
  const out: Record<string, number> = {};
  for (const spec of definition.params) {
    const value = raw[spec.key] ?? spec.default;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < spec.min ||
      value > spec.max
    )
      throw new IndicatorSchemaError(
        `${id}: ${spec.key} must be an integer in ${spec.min}..${spec.max}`,
      );
    out[spec.key] = value;
  }
  return out;
}

function normalizeStyle(
  definition: IndicatorDefinition,
  raw: unknown,
  id: string,
): Record<string, string | number> {
  if (!isRecord(raw)) throw new IndicatorSchemaError(`${id}: style must be an object`);
  const known = new Set(definition.style.map((s) => s.key));
  for (const key of Object.keys(raw))
    if (!known.has(key)) throw new IndicatorSchemaError(`${id}: unknown style field ${key}`);
  const out: Record<string, string | number> = {};
  for (const spec of definition.style) {
    const value = raw[spec.key] ?? spec.default;
    if (spec.kind === 'color') {
      if (typeof value !== 'string' || value.trim() === '')
        throw new IndicatorSchemaError(`${id}: ${spec.key} must be a CSS color`);
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 5) {
      throw new IndicatorSchemaError(`${id}: ${spec.key} must be a width in 0.5..5`);
    }
    out[spec.key] = value;
  }
  return out;
}

function sameConfig(a: IndicatorInstance, b: IndicatorInstance): boolean {
  return (
    a.visible === b.visible &&
    sameRecord(a.params, b.params) &&
    sameRecord(a.style, b.style) &&
    a.type === b.type
  );
}

function sameRecord(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
