export {
  FumeChart,
  type ChartData,
  type FollowingLatestState,
  type FumeChartOptions,
  type OlderDataRequest,
  type OlderDataState,
  type PrependOptions,
} from './chart.ts';
export type { MergeResult } from './series.ts';
export type { ChartTheme } from './theme.ts';
export { DEFAULT_THEME } from './theme.ts';
export type { ChartEnvironment, ElementSize } from './environment.ts';
export type { Frame } from './frame.ts';
export type { ViewState, ViewLimits } from './view-state.ts';
export { DEFAULT_VIEW_LIMITS } from './view-state.ts';
export type { CrosshairModel } from './interaction.ts';
export type { ChartCoordinates, ChartPoint } from './coordinates.ts';
export type { Rect } from './layout.ts';
export {
  ANCHOR_COUNT,
  DRAWING_DOCUMENT_FORMAT,
  DRAWING_SCHEMA_VERSION,
  DRAWING_TYPES,
  DrawingSchemaError,
  isDrawingType,
  parseDrawingDocument,
  serializeDrawings,
  type Drawing,
  type DrawingAnchor,
  type DrawingChange,
  type DrawingDocument,
  type DrawingStyle,
  type DrawingTool,
  type DrawingType,
  type LineStyle,
} from './drawings/model.ts';
export type { DrawingInteractionState } from './drawings/controller.ts';
export { applyDrawingPatch, type DrawingPatch, type DrawingStylePatch } from './drawings/model.ts';
export { DRAWING_HISTORY_LIMIT, type DrawingHistoryState } from './drawings/history.ts';
export {
  drawingCommandForKey,
  isTextEntryTarget,
  type DrawingCommand,
  type KeyInput,
} from './drawings/keyboard.ts';
export type { PaneFrame, PaneScaleSpec } from './frame.ts';
export type { PaneLayout } from './layout.ts';
// Indicators: definitions, schema and model helpers come from @fume/indicators (docs/indicators.md);
// the chart owns their runtime state, panes and rendering.
export {
  applyIndicatorPatch,
  BUILTIN_INDICATORS,
  createIndicator,
  INDICATOR_DOCUMENT_FORMAT,
  INDICATOR_SCHEMA_VERSION,
  IndicatorSchemaError,
  normalizeIndicator,
  parseIndicatorDocument,
  serializeIndicators,
  type IndicatorChange,
  type IndicatorDefinition,
  type IndicatorDocument,
  type IndicatorInstance,
  type IndicatorParamSpec,
  type IndicatorPatch,
  type IndicatorStyleSpec,
} from '@fume/indicators';
