import { useEffect, useState } from 'react';
import type { StreamState, TimeframeId } from '@fume/core';
import { FumeApiDataFeed, type ChartStatus, type DataFeed } from '@fume/datafeed';
import { ChartHost } from './ChartHost.tsx';
import { feedLabel } from './feed-label.ts';
import { TIMEFRAME_LABELS } from './timeframes.ts';

/**
 * Embedding proof (`?source=api&proof=two-charts`): two independent charts on one page, NQ 5m and
 * ES 1h, sharing ONE DataFeed and therefore one stream connection to the futures hub. The footer
 * shows the feed's stream diagnostics (connections, sockets created, subscriptions).
 */
const CHARTS: readonly { symbol: string; timeframe: TimeframeId }[] = [
  { symbol: 'NQ', timeframe: '5m' },
  { symbol: 'ES', timeframe: '1h' },
];

export function TwoChartProof({ datafeed }: { datafeed: DataFeed }) {
  const [diagnostics, setDiagnostics] = useState('');
  useEffect(() => {
    const read = () => {
      if (datafeed instanceof FumeApiDataFeed) {
        setDiagnostics(JSON.stringify(datafeed.streamDiagnostics()));
      }
    };
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, [datafeed]);

  return (
    <div className="app proof">
      <header className="app-header">
        <span className="brand">Fume</span>
        <span className="meta">Two-chart proof · one shared DataFeed</span>
      </header>
      <main className="proof-grid">
        {CHARTS.map((c, i) => (
          <ProofPane key={c.symbol} datafeed={datafeed} {...c} devName={String(i + 1)} />
        ))}
      </main>
      <footer className="proof-footer" data-testid="proof-diagnostics">
        stream connections: {diagnostics || '(none)'}
      </footer>
    </div>
  );
}

function ProofPane({
  datafeed,
  symbol,
  timeframe,
  devName,
}: {
  datafeed: DataFeed;
  symbol: string;
  timeframe: TimeframeId;
  devName: string;
}) {
  const [status, setStatus] = useState<ChartStatus | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const ready = status?.kind === 'ready' ? status : null;
  return (
    <section className="proof-pane">
      <div className="proof-title">
        <strong>{symbol}</strong>
        <span className="contract">{ready?.instrument.displaySymbol ?? '…'}</span>
        <span className="meta">{TIMEFRAME_LABELS[timeframe]}</span>
        <span className="feed">
          {ready ? feedLabel(ready.feed, ready.streaming, stream) : (status?.kind ?? 'loading')}
        </span>
      </div>
      <div className="chart-area">
        <ChartHost
          datafeed={datafeed}
          symbol={symbol}
          assetClass="future"
          timeframe={timeframe}
          onStatus={setStatus}
          onStreamState={setStream}
          devName={devName}
        />
      </div>
    </section>
  );
}
