import { useEffect, useRef } from 'react';
import { FumeChart, type ChartData } from '@fume/chart';

export interface ChartHostProps {
  /** One series: bars, time scale, formatters, tick and initial view. Replaced atomically. */
  data: ChartData;
}

/**
 * Hosts the framework-independent FumeChart. React only provides the container, creates and
 * destroys the engine, and hands it new data. Zoom, pan, crosshair, sizing and rendering all live
 * in the engine; none of it goes through React state.
 */
export function ChartHost({ data }: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<FumeChart | null>(null);
  const appliedRef = useRef<ChartData | null>(null);
  const latestData = useRef(data);
  latestData.current = data;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = latestData.current;
    const chart = new FumeChart(container, {
      timeScale: initial.timeScale,
      formatPrice: initial.formatPrice,
      formatTime: initial.formatTime,
      minPriceStep: initial.minPriceStep,
    });
    chart.setData(initial);
    chartRef.current = chart;
    appliedRef.current = initial;
    // Dev-only QA handle (stripped from production builds): read engine state from the console.
    if (import.meta.env.DEV) (window as unknown as { __fumeChart?: FumeChart }).__fumeChart = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
      appliedRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || appliedRef.current === data) return;
    chart.setData(data);
    appliedRef.current = data;
  }, [data]);

  return <div ref={containerRef} className="chart-host" data-testid="fume-chart" />;
}
