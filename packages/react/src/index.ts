/**
 * @fume/react public entry point (docs/embedding.md): <FumeChartView /> and its types. A thin
 * React binding over @fume/chart and @fume/datafeed; React is a peer dependency.
 */
export {
  FumeChartView,
  type FumeChartViewHandle,
  type FumeChartViewProps,
} from './FumeChartView.tsx';
export type { FumeChartViewState } from './binding.ts';
// Drawing types used by the props/handle (the model and its helpers live in @fume/chart).
export type {
  Drawing,
  DrawingChange,
  DrawingHistoryState,
  DrawingPatch,
  DrawingStyle,
  DrawingTool,
  DrawingType,
  LineStyle,
} from '@fume/chart';
