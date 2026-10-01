/**
 * Reference drawing toolbar (left rail). The chart engine has no built-in drawing UI: hosts
 * provide their own and drive it through FumeChartView's handle and drawing callbacks. Tools on
 * top, then undo/redo (enabled from onDrawingHistoryChange) and the drawing list toggle.
 */
import type { ReactNode } from 'react';
import type { DrawingHistoryState, DrawingTool } from '@fume/react';
import { Icon } from './icons.tsx';

const TOOLS: readonly { tool: DrawingTool; title: string; icon: ReactNode }[] = [
  { tool: 'cursor', title: 'Cursor: select, move and edit drawings (Esc)', icon: Icon.cursor },
  { tool: 'trend-line', title: 'Trend line: click two points', icon: Icon.trendLine },
  { tool: 'horizontal-line', title: 'Horizontal line: click once', icon: Icon.horizontalLine },
  { tool: 'rectangle', title: 'Rectangle: click two corners', icon: Icon.rectangle },
];

export function DrawingToolbar(props: {
  tool: DrawingTool;
  onSelect: (tool: DrawingTool) => void;
  history: DrawingHistoryState;
  onUndo: () => void;
  onRedo: () => void;
  drawingCount: number;
  listOpen: boolean;
  onToggleList: () => void;
}) {
  return (
    <div
      className="drawing-tools"
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
    >
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          type="button"
          title={t.title}
          aria-label={t.title}
          aria-pressed={props.tool === t.tool}
          onClick={() => props.onSelect(t.tool)}
        >
          {t.icon}
        </button>
      ))}
      <span className="drawing-tools-separator" aria-hidden="true" />
      <button
        type="button"
        title="Undo drawing change (Ctrl+Z)"
        aria-label="Undo drawing change"
        disabled={!props.history.canUndo}
        onClick={props.onUndo}
      >
        {Icon.undo}
      </button>
      <button
        type="button"
        title="Redo drawing change (Ctrl+Shift+Z or Ctrl+Y)"
        aria-label="Redo drawing change"
        disabled={!props.history.canRedo}
        onClick={props.onRedo}
      >
        {Icon.redo}
      </button>
      <span className="drawing-tools-separator" aria-hidden="true" />
      <button
        type="button"
        className="drawing-tools-list"
        title={`Drawings on this chart (${props.drawingCount})`}
        aria-label={`Drawings on this chart (${props.drawingCount})`}
        aria-pressed={props.listOpen}
        aria-expanded={props.listOpen}
        disabled={props.drawingCount === 0 && !props.listOpen}
        onClick={props.onToggleList}
      >
        {Icon.list}
        {props.drawingCount > 0 && <span className="drawing-count">{props.drawingCount}</span>}
      </button>
    </div>
  );
}
