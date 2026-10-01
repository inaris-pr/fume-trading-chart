/**
 * <FumeChartView /> markup and public surface (server rendering: effects do not run, so no chart is
 * created here; the lifecycle is covered by binding.test.ts and the app's StrictMode run).
 */
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { ReplayDataFeed } from '@fume/datafeed';
import { FumeChartView, type FumeChartViewHandle } from '../src/index.ts';

const feed = new ReplayDataFeed({ olderPageDelayMs: 0 });

describe('FumeChartView', () => {
  test('renders a positioned root and the engine container with stable class hooks', () => {
    const html = renderToStaticMarkup(
      <FumeChartView
        datafeed={feed}
        symbol="SPY"
        timeframe="5m"
        className="host-chart"
        style={{ height: 300 }}
      />,
    );
    expect(html).toContain('class="fume-chart host-chart"');
    expect(html).toContain('position:relative');
    expect(html).toContain('height:300px');
    expect(html).toContain('class="fume-chart-canvas"');
    expect(html).toContain('data-testid="fume-chart"');
    // No chrome before the chart reports anything.
    expect(html).not.toContain('fume-chart-latest');
    expect(html).not.toContain('fume-chart-status');
  });

  test('the ref handle exposes only the small imperative API', () => {
    const ref = createRef<FumeChartViewHandle>();
    renderToStaticMarkup(<FumeChartView ref={ref} datafeed={feed} symbol="SPY" timeframe="5m" />);
    // Server rendering does not attach refs; the handle's shape is checked via its type here: the
    // Record must name every handle member (compile error otherwise) and nothing else.
    const members: Record<keyof FumeChartViewHandle, true> = {
      goToLatest: true,
      setTimeframe: true,
      selectInstrument: true,
      getState: true,
      setDrawingTool: true,
      getDrawingTool: true,
      getDrawings: true,
      selectDrawing: true,
      getSelectedDrawingId: true,
      editDrawing: true,
      duplicateDrawing: true,
      deleteDrawing: true,
      undoDrawing: true,
      redoDrawing: true,
      getDrawingHistory: true,
      handleKeyDown: true,
    };
    expect(Object.keys(members)).toHaveLength(16);
  });
});
