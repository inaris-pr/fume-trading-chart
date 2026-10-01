/**
 * Drawing model (docs/drawings.md): plain, serializable data anchored in MARKET coordinates
 * (time + price), never pixels. Pure and DOM-free. The chart renders and edits drawings; the host
 * owns persistence (serializeDrawings / parseDrawingDocument).
 *
 * Interaction state (selection, hover, an unfinished drawing) is NOT part of the model.
 */
import type { UnixMs } from '@fume/core';

/** Bumped on any incompatible change to the persisted shape; parse rejects unknown versions. */
export const DRAWING_SCHEMA_VERSION = 1;
export const DRAWING_DOCUMENT_FORMAT = 'fume.drawings';

export type DrawingType = 'trend-line' | 'horizontal-line' | 'rectangle';
/** The active interaction tool: `cursor` selects/moves; a drawing type creates one. */
export type DrawingTool = 'cursor' | DrawingType;

export const DRAWING_TYPES: readonly DrawingType[] = ['trend-line', 'horizontal-line', 'rectangle'];

/** Anchors each drawing type has (the model is invalid with any other count). */
export const ANCHOR_COUNT: Readonly<Record<DrawingType, number>> = {
  'trend-line': 2, // the two end points
  'horizontal-line': 1, // price; the time only places its handle
  rectangle: 2, // opposite corners
};

/** A point in market coordinates. `time` is a real timestamp, not a bar index. */
export interface DrawingAnchor {
  time: UnixMs;
  price: number;
}

export type LineStyle = 'solid' | 'dashed' | 'dotted';

export interface DrawingStyle {
  /** CSS color of lines and handles. */
  color: string;
  /** CSS px. */
  lineWidth: number;
  lineStyle: LineStyle;
  /** Area fill (rectangle). Absent: no fill. */
  fillColor?: string;
}

export interface Drawing {
  /** Unique within one chart's drawing set. */
  id: string;
  type: DrawingType;
  anchors: readonly DrawingAnchor[];
  style: DrawingStyle;
  /** Hidden drawings are neither painted nor hit-tested. */
  visible: boolean;
  /** Locked drawings can be selected but not moved, reshaped or deleted by the user. */
  locked: boolean;
}

/** What a user action changed (reported with the full new drawing set). */
export interface DrawingChange {
  kind: 'add' | 'update' | 'remove';
  id: string;
  /**
   * `edit`: a direct user edit; `undo` / `redo`: history navigation (the kind is then the effect,
   * e.g. undoing an add reports a remove).
   */
  source: 'edit' | 'undo' | 'redo';
}

/** Style fields to change; `fillColor: null` removes the fill. Omitted fields stay as they are. */
export type DrawingStylePatch = Partial<Omit<DrawingStyle, 'fillColor'>> & {
  fillColor?: string | null;
};

/** A user edit of a drawing's appearance or state (never its anchors; those change by dragging). */
export interface DrawingPatch {
  style?: DrawingStylePatch;
  visible?: boolean;
  locked?: boolean;
}

const LINE_STYLES: readonly LineStyle[] = ['solid', 'dashed', 'dotted'];

/**
 * The drawing with `patch` applied (pure), the same object when nothing changes, or null when the
 * patch is invalid (empty color, non-positive or non-finite width, unknown line style).
 */
export function applyDrawingPatch(drawing: Drawing, patch: DrawingPatch): Drawing | null {
  const style: DrawingStyle = { ...drawing.style };
  const p = patch.style ?? {};
  if (p.color !== undefined) {
    if (typeof p.color !== 'string' || p.color.trim() === '') return null;
    style.color = p.color;
  }
  if (p.lineWidth !== undefined) {
    if (!Number.isFinite(p.lineWidth) || p.lineWidth <= 0) return null;
    style.lineWidth = p.lineWidth;
  }
  if (p.lineStyle !== undefined) {
    if (!LINE_STYLES.includes(p.lineStyle)) return null;
    style.lineStyle = p.lineStyle;
  }
  if (p.fillColor === null) {
    delete style.fillColor;
  } else if (p.fillColor !== undefined) {
    if (typeof p.fillColor !== 'string' || p.fillColor.trim() === '') return null;
    style.fillColor = p.fillColor;
  }
  const next: Drawing = {
    ...drawing,
    style,
    visible: patch.visible ?? drawing.visible,
    locked: patch.locked ?? drawing.locked,
  };
  return sameDrawingState(drawing, next) ? drawing : next;
}

function sameDrawingState(a: Drawing, b: Drawing): boolean {
  return (
    a.visible === b.visible &&
    a.locked === b.locked &&
    a.style.color === b.style.color &&
    a.style.lineWidth === b.style.lineWidth &&
    a.style.lineStyle === b.style.lineStyle &&
    a.style.fillColor === b.style.fillColor
  );
}

/** Persisted form: a versioned envelope around the drawings. JSON-safe. */
export interface DrawingDocument {
  format: typeof DRAWING_DOCUMENT_FORMAT;
  version: typeof DRAWING_SCHEMA_VERSION;
  drawings: Drawing[];
}

export class DrawingSchemaError extends Error {
  override readonly name = 'DrawingSchemaError';
}

export function isDrawingType(value: unknown): value is DrawingType {
  return typeof value === 'string' && (DRAWING_TYPES as readonly string[]).includes(value);
}

/** True when the drawing has the anchor count of its type and finite coordinates. */
export function hasValidAnchors(drawing: Pick<Drawing, 'type' | 'anchors'>): boolean {
  return (
    drawing.anchors.length === ANCHOR_COUNT[drawing.type] &&
    drawing.anchors.every((a) => Number.isFinite(a.time) && Number.isFinite(a.price))
  );
}

/**
 * Canonical persisted form: fixed key order, only model fields (no interaction state), so equal
 * drawings always serialize to the same JSON.
 */
export function serializeDrawings(drawings: readonly Drawing[]): DrawingDocument {
  return {
    format: DRAWING_DOCUMENT_FORMAT,
    version: DRAWING_SCHEMA_VERSION,
    drawings: drawings.map(normalizeDrawing),
  };
}

/**
 * Validates untrusted persisted data (e.g. JSON from the host's storage) and returns drawings.
 * Throws DrawingSchemaError for another format/version or any invalid drawing; nothing is
 * silently dropped or guessed.
 */
export function parseDrawingDocument(value: unknown): Drawing[] {
  if (!isRecord(value) || value.format !== DRAWING_DOCUMENT_FORMAT)
    throw new DrawingSchemaError('Not a Fume drawing document');
  if (value.version !== DRAWING_SCHEMA_VERSION)
    throw new DrawingSchemaError(`Unsupported drawing schema version ${String(value.version)}`);
  if (!Array.isArray(value.drawings)) throw new DrawingSchemaError('drawings must be an array');
  const ids = new Set<string>();
  return value.drawings.map((raw, i) => {
    const drawing = parseDrawing(raw, i);
    if (ids.has(drawing.id)) throw new DrawingSchemaError(`Duplicate drawing id ${drawing.id}`);
    ids.add(drawing.id);
    return drawing;
  });
}

function parseDrawing(raw: unknown, index: number): Drawing {
  const where = `drawings[${index}]`;
  if (!isRecord(raw)) throw new DrawingSchemaError(`${where} is not an object`);
  const { id, type, anchors, style, visible, locked } = raw;
  if (typeof id !== 'string' || id.length === 0)
    throw new DrawingSchemaError(`${where}.id must be a non-empty string`);
  if (!isDrawingType(type)) throw new DrawingSchemaError(`${where}.type is unknown`);
  if (!Array.isArray(anchors) || anchors.length !== ANCHOR_COUNT[type])
    throw new DrawingSchemaError(`${where}.anchors must hold ${ANCHOR_COUNT[type]} points`);
  const parsedAnchors = anchors.map((a, j) => {
    if (!isRecord(a) || !isFiniteNumber(a.time) || !isFiniteNumber(a.price))
      throw new DrawingSchemaError(`${where}.anchors[${j}] needs finite time and price`);
    return { time: a.time, price: a.price };
  });
  if (!isRecord(style)) throw new DrawingSchemaError(`${where}.style is not an object`);
  const { color, lineWidth, lineStyle, fillColor } = style;
  if (typeof color !== 'string') throw new DrawingSchemaError(`${where}.style.color`);
  if (!isFiniteNumber(lineWidth) || lineWidth <= 0)
    throw new DrawingSchemaError(`${where}.style.lineWidth`);
  if (lineStyle !== 'solid' && lineStyle !== 'dashed' && lineStyle !== 'dotted')
    throw new DrawingSchemaError(`${where}.style.lineStyle`);
  if (fillColor !== undefined && typeof fillColor !== 'string')
    throw new DrawingSchemaError(`${where}.style.fillColor`);
  if (typeof visible !== 'boolean' || typeof locked !== 'boolean')
    throw new DrawingSchemaError(`${where}.visible/locked must be booleans`);
  return normalizeDrawing({
    id,
    type,
    anchors: parsedAnchors,
    style: { color, lineWidth, lineStyle, ...(fillColor !== undefined ? { fillColor } : {}) },
    visible,
    locked,
  });
}

function normalizeDrawing(d: Drawing): Drawing {
  return {
    id: d.id,
    type: d.type,
    anchors: d.anchors.map((a) => ({ time: a.time, price: a.price })),
    style: {
      color: d.style.color,
      lineWidth: d.style.lineWidth,
      lineStyle: d.style.lineStyle,
      ...(d.style.fillColor !== undefined ? { fillColor: d.style.fillColor } : {}),
    },
    visible: d.visible,
    locked: d.locked,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
