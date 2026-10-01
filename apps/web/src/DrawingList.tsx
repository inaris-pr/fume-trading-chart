/**
 * Minimal drawing list (reference UI): every drawing of the current instrument, top of the z-order
 * first, with show/hide and lock toggles. Its main job is restoring hidden drawings (which cannot
 * be clicked on the chart); clicking a visible row selects that drawing.
 */
import type { Drawing, DrawingPatch, DrawingType } from '@fume/react';
import { Icon } from './icons.tsx';

const TYPE_LABEL: Readonly<Record<DrawingType, string>> = {
  'trend-line': 'Trend line',
  'horizontal-line': 'Horizontal line',
  rectangle: 'Rectangle',
};

export function DrawingList(props: {
  drawings: readonly Drawing[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: DrawingPatch) => void;
  onClose: () => void;
}) {
  // Stable per-type numbering in creation order; listed top (last drawn) first.
  const counts = new Map<DrawingType, number>();
  const rows = props.drawings.map((d) => {
    const n = (counts.get(d.type) ?? 0) + 1;
    counts.set(d.type, n);
    return { d, label: `${TYPE_LABEL[d.type]} ${n}` };
  });
  return (
    <div className="drawing-list" role="dialog" aria-label="Drawings">
      <div className="drawing-list-header">
        <span>Drawings</span>
        <button type="button" aria-label="Close drawing list" onClick={props.onClose}>
          {Icon.close}
        </button>
      </div>
      {rows.length === 0 && <div className="drawing-list-empty">No drawings</div>}
      <ul>
        {rows.reverse().map(({ d, label }) => (
          <li
            key={d.id}
            className={[
              d.id === props.selectedId ? 'selected' : '',
              d.visible ? '' : 'is-hidden',
            ].join(' ')}
          >
            <button
              type="button"
              className="drawing-list-name"
              disabled={!d.visible}
              title={d.visible ? 'Select' : 'Hidden: show it to select it'}
              onClick={() => props.onSelect(d.id)}
            >
              <span className="swatch" style={{ background: d.style.color }} />
              {label}
            </button>
            <button
              type="button"
              aria-label={d.visible ? `Hide ${label}` : `Show ${label}`}
              title={d.visible ? 'Hide' : 'Show'}
              aria-pressed={!d.visible}
              onClick={() => props.onEdit(d.id, { visible: !d.visible })}
            >
              {d.visible ? Icon.visible : Icon.hidden}
            </button>
            <button
              type="button"
              aria-label={d.locked ? `Unlock ${label}` : `Lock ${label}`}
              title={d.locked ? 'Unlock' : 'Lock'}
              aria-pressed={d.locked}
              onClick={() => props.onEdit(d.id, { locked: !d.locked })}
            >
              {d.locked ? Icon.locked : Icon.unlocked}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
