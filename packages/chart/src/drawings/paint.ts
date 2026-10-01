/**
 * Paints the drawing layer (its own canvas between candles and crosshair): every visible drawing
 * in z-order, clipped to the plot, plus hover emphasis, edit handles of the selected drawing and
 * the preview of an unfinished drawing. Never touches the candle layer, so a drawing edit or hover
 * change repaints only this canvas.
 */
import type { Frame } from '../frame.ts';
import type { ChartTheme } from '../theme.ts';
import type { DrawingGeometry } from './geometry.ts';
import { HANDLE_RADIUS } from './hit-test.ts';
import type { LineStyle } from './model.ts';

export type DrawingPaintContext = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'clearRect'
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'arc'
  | 'fill'
  | 'fillRect'
  | 'setLineDash'
> & {
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

export interface DrawingPaintState {
  selectedId: string | null;
  hoveredId: string | null;
  /** The unfinished drawing following the pointer (painted on top, with its handles). */
  preview: DrawingGeometry | null;
}

export function paintDrawings(
  ctx: DrawingPaintContext,
  frame: Pick<Frame, 'layout' | 'pixelRatio'>,
  geometries: readonly DrawingGeometry[],
  state: DrawingPaintState,
  theme: ChartTheme,
): void {
  const pr = frame.pixelRatio;
  const { layout } = frame;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, Math.round(layout.width * pr), Math.round(layout.height * pr));
  if (geometries.length === 0 && !state.preview) return;

  const { plot } = layout;
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    Math.round(plot.x * pr),
    Math.round(plot.y * pr),
    Math.round(plot.width * pr),
    Math.round(plot.height * pr),
  );
  ctx.clip();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  let selected: DrawingGeometry | null = null;
  for (const g of geometries) {
    paintShape(ctx, g, plot.x, plot.width, pr, g.drawing.id === state.hoveredId);
    if (g.drawing.id === state.selectedId) selected = g;
  }
  if (state.preview) paintShape(ctx, state.preview, plot.x, plot.width, pr, false);
  if (selected && !selected.drawing.locked) paintHandles(ctx, selected, pr, theme);
  if (state.preview) paintHandles(ctx, state.preview, pr, theme);
  ctx.restore();
}

function paintShape(
  ctx: DrawingPaintContext,
  g: DrawingGeometry,
  plotX: number,
  plotWidth: number,
  pr: number,
  hovered: boolean,
): void {
  const { style } = g.drawing;
  const width = Math.max(1, Math.round(style.lineWidth * pr)) + (hovered ? Math.round(pr) : 0);
  // Odd device widths sit on half pixels so axis-parallel lines stay crisp.
  const crisp = (v: number) => Math.round(v * pr) + (width % 2 === 1 ? 0.5 : 0);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashPattern(style.lineStyle, width, pr));
  const { shape } = g;
  ctx.beginPath();
  switch (shape.kind) {
    case 'segment':
      ctx.moveTo(shape.a.x * pr, shape.a.y * pr);
      ctx.lineTo(shape.b.x * pr, shape.b.y * pr);
      break;
    case 'horizontal': {
      const y = crisp(shape.y);
      ctx.moveTo(Math.round(plotX * pr), y);
      ctx.lineTo(Math.round((plotX + plotWidth) * pr), y);
      break;
    }
    case 'rect': {
      const left = crisp(shape.left);
      const top = crisp(shape.top);
      const w = crisp(shape.right) - left;
      const h = crisp(shape.bottom) - top;
      if (style.fillColor !== undefined) {
        ctx.fillStyle = style.fillColor;
        ctx.fillRect(left, top, w, h);
      }
      ctx.rect(left, top, w, h);
      break;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function paintHandles(
  ctx: DrawingPaintContext,
  g: DrawingGeometry,
  pr: number,
  theme: ChartTheme,
): void {
  ctx.lineWidth = Math.max(1, Math.round(1.5 * pr));
  ctx.strokeStyle = g.drawing.style.color;
  ctx.fillStyle = theme.background;
  for (const h of g.handles) {
    ctx.beginPath();
    ctx.arc(h.x * pr, h.y * pr, HANDLE_RADIUS * pr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function dashPattern(lineStyle: LineStyle, width: number, pr: number): number[] {
  if (lineStyle === 'dashed') return [Math.round(6 * pr) + width, Math.round(4 * pr) + width];
  if (lineStyle === 'dotted') return [width, Math.round(2 * pr) + width];
  return [];
}
