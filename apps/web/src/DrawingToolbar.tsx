/**
 * Reference drawing toolbar. The chart engine has no built-in drawing UI: hosts provide their own
 * and drive it through FumeChartView's setDrawingTool / onDrawingToolChange.
 */
import type { ReactNode } from 'react';
import type { DrawingTool } from '@fume/react';

const icon = (children: ReactNode) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const TOOLS: readonly { tool: DrawingTool; title: string; icon: ReactNode }[] = [
  {
    tool: 'cursor',
    title: 'Cursor: select, move and edit drawings (Esc)',
    icon: icon(
      <path d="M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4.1h3.8z" fill="currentColor" stroke="none" />,
    ),
  },
  {
    tool: 'trend-line',
    title: 'Trend line: click two points',
    icon: icon(
      <>
        <path d="M4 12L12 4" />
        <circle cx="3.5" cy="12.5" r="1.6" />
        <circle cx="12.5" cy="3.5" r="1.6" />
      </>,
    ),
  },
  {
    tool: 'horizontal-line',
    title: 'Horizontal line: click once',
    icon: icon(
      <>
        <path d="M1.5 8h4.4M10.1 8h4.4" />
        <circle cx="8" cy="8" r="1.6" />
      </>,
    ),
  },
  {
    tool: 'rectangle',
    title: 'Rectangle: click two corners',
    icon: icon(<rect x="2.5" y="4" width="11" height="8" rx="0.5" />),
  },
];

export function DrawingToolbar(props: {
  tool: DrawingTool;
  onSelect: (tool: DrawingTool) => void;
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
    </div>
  );
}
