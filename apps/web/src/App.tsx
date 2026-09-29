import { useMemo } from 'react';
import { ChartHost } from './ChartHost.tsx';
import { buildDemoDataset, DEMO_BAR_COUNT, parseScenario } from './demo/dataset.ts';

/** Dev-only query parameters for visual checks: ?scenario=flat|negative|subpenny&bars=N */
function readDemoParams(): { scenario: ReturnType<typeof parseScenario>; bars: number } {
  const params = new URLSearchParams(window.location.search);
  const bars = Number(params.get('bars'));
  return {
    scenario: parseScenario(params.get('scenario')),
    bars: Number.isInteger(bars) && bars > 0 && bars <= 50_000 ? bars : DEMO_BAR_COUNT,
  };
}

export function App() {
  const dataset = useMemo(() => {
    const { scenario, bars } = readDemoParams();
    return buildDemoDataset(scenario, bars);
  }, []);
  const last = dataset.bars[dataset.bars.length - 1];

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Fume</span>
        <span className="symbol">{dataset.instrument.displaySymbol}</span>
        <span className="meta">{dataset.timeframeLabel}</span>
        <span className="meta">RTH</span>
        {last && <span className="price">{dataset.formatPrice(last.close)}</span>}
        <span className="feed" title="Deterministic seeded replay data, not market data">
          Replay data · not live
        </span>
      </header>
      <main className="chart-area">
        <ChartHost
          bars={dataset.bars}
          timeScale={dataset.timeScale}
          formatPrice={dataset.formatPrice}
          formatTime={dataset.formatTime}
          minPriceStep={dataset.minPriceStep}
        />
      </main>
    </div>
  );
}
