import { useEffect, useRef } from 'react';
import { FumeChart } from '@fume/chart';
import type { Bar, PriceFormatter, TimeFormatter, TimeScaleMapping } from '@fume/core';

export interface ChartHostProps {
  bars: readonly Bar[];
  timeScale: TimeScaleMapping;
  formatPrice: PriceFormatter;
  formatTime: TimeFormatter;
  minPriceStep: number;
}

/**
 * Hosts the framework-independent FumeChart. React only provides the container and forwards
 * props into imperative calls; it never renders, sizes or animates the chart. The engine observes
 * the container's size itself.
 */
export function ChartHost(props: ChartHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<FumeChart | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { bars, timeScale, formatPrice, formatTime, minPriceStep } = latestProps.current;
    const chart = new FumeChart(container, { timeScale, formatPrice, formatTime, minPriceStep });
    chart.setBars(bars);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  const { bars, timeScale, formatPrice, formatTime, minPriceStep } = props;
  useEffect(() => {
    chartRef.current?.setOptions({ timeScale, formatPrice, formatTime, minPriceStep });
  }, [timeScale, formatPrice, formatTime, minPriceStep]);
  useEffect(() => {
    chartRef.current?.setBars(bars);
  }, [bars]);

  return <div ref={containerRef} className="chart-host" data-testid="fume-chart" />;
}
