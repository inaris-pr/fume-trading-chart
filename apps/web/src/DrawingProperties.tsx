/**
 * Contextual controls for the selected drawing (reference UI). A compact floating bar over the
 * chart; every control sends ONE edit to the engine (FumeChartView.editDrawing / duplicate /
 * delete), which applies the rules (locked drawings cannot be deleted), records the undo step and
 * reports the new set. Discrete swatches and selects only, so each click is one history entry.
 */
import { useState } from 'react';
import type { Drawing, DrawingPatch, LineStyle } from '@fume/react';
import { opaqueHex, parseColor, withAlpha } from './colors.ts';
import { Icon } from './icons.tsx';

export const SWATCHES: readonly string[] = [
  '#5b8cff',
  '#26b27a',
  '#e2484d',
  '#f5a623',
  '#b36bff',
  '#2ec4d6',
  '#d5dae3',
  '#8f98a8',
];
const WIDTHS = [1, 2, 3, 4] as const;
const LINE_STYLES: readonly { value: LineStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];
/** Fill opacity steps (0 keeps the color but shows no fill). */
const OPACITIES = [0, 0.1, 0.2, 0.35, 0.5] as const;

type Palette = 'line' | 'fill' | null;

export function DrawingProperties(props: {
  drawing: Drawing;
  onEdit: (patch: DrawingPatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { drawing, onEdit } = props;
  const [palette, setPalette] = useState<Palette>(null);
  const { style, locked } = drawing;
  const fill = style.fillColor !== undefined ? parseColor(style.fillColor) : null;
  const fillAlpha = fill?.a ?? 0;
  const fillHex = style.fillColor !== undefined ? opaqueHex(style.fillColor) : null;

  const pick = (color: string) => {
    if (palette === 'line') onEdit({ style: { color } });
    if (palette === 'fill') onEdit({ style: { fillColor: withAlpha(color, fillAlpha || 0.2) } });
    setPalette(null);
  };

  return (
    <div className="drawing-props" role="toolbar" aria-label="Selected drawing">
      <button
        type="button"
        className="swatch-button"
        title="Line color"
        aria-label="Line color"
        aria-expanded={palette === 'line'}
        onClick={() => setPalette(palette === 'line' ? null : 'line')}
      >
        <span className="swatch" style={{ background: style.color }} />
      </button>
      <select
        aria-label="Line width"
        title="Line width"
        value={style.lineWidth}
        onChange={(e) => onEdit({ style: { lineWidth: Number(e.target.value) } })}
      >
        {WIDTHS.map((w) => (
          <option key={w} value={w}>
            {w}px
          </option>
        ))}
      </select>
      <select
        aria-label="Line style"
        title="Line style"
        value={style.lineStyle}
        onChange={(e) => onEdit({ style: { lineStyle: e.target.value as LineStyle } })}
      >
        {LINE_STYLES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {drawing.type === 'rectangle' && (
        <>
          <span className="drawing-props-separator" aria-hidden="true" />
          <button
            type="button"
            className="swatch-button"
            title="Fill color"
            aria-label="Fill color"
            aria-expanded={palette === 'fill'}
            onClick={() => setPalette(palette === 'fill' ? null : 'fill')}
          >
            <span className="swatch swatch-fill" style={{ background: fillHex ?? 'transparent' }} />
          </button>
          <select
            aria-label="Fill opacity"
            title="Fill opacity"
            value={nearest(OPACITIES, fillAlpha)}
            onChange={(e) => {
              const a = Number(e.target.value);
              onEdit({
                style: {
                  fillColor: a === 0 ? null : withAlpha(fillHex ?? style.color, a),
                },
              });
            }}
          >
            {OPACITIES.map((a) => (
              <option key={a} value={a}>
                {a === 0 ? 'No fill' : `${Math.round(a * 100)}%`}
              </option>
            ))}
          </select>
        </>
      )}
      <span className="drawing-props-separator" aria-hidden="true" />
      <button
        type="button"
        title={locked ? 'Unlock (allow moving and deleting)' : 'Lock (prevent moving and deleting)'}
        aria-label={locked ? 'Unlock drawing' : 'Lock drawing'}
        aria-pressed={locked}
        onClick={() => onEdit({ locked: !locked })}
      >
        {locked ? Icon.locked : Icon.unlocked}
      </button>
      <button
        type="button"
        title="Hide (restore from the drawing list)"
        aria-label="Hide drawing"
        onClick={() => onEdit({ visible: false })}
      >
        {Icon.hidden}
      </button>
      <button
        type="button"
        title="Duplicate (Ctrl+D)"
        aria-label="Duplicate drawing"
        onClick={props.onDuplicate}
      >
        {Icon.duplicate}
      </button>
      <button
        type="button"
        title={locked ? 'Locked drawings cannot be deleted' : 'Delete (Del)'}
        aria-label="Delete drawing"
        disabled={locked}
        onClick={props.onDelete}
      >
        {Icon.trash}
      </button>
      {palette && (
        <div className="swatch-palette" role="listbox" aria-label={`${palette} color`}>
          {SWATCHES.map((c) => {
            const current = palette === 'line' ? opaqueHex(style.color) : fillHex;
            return (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={current === c}
                aria-label={c}
                title={c}
                onClick={() => pick(c)}
              >
                <span className="swatch" style={{ background: c }} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function nearest(values: readonly number[], v: number): number {
  return values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best));
}
