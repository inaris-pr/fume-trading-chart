import { useState } from 'react';
import type { TimeframeId } from '@fume/core';
import { isReplaySymbol, REPLAY_SYMBOLS, ReplayMarketDataProvider } from '@fume/replay';
import { ChartHost, type ChartSource } from './ChartHost.tsx';
import { FumeHttpClient } from './api/fume-client.ts';
import { feedLabel, feedTitle } from './feed-label.ts';
import type { HistoryStatus } from './history/historical-controller.ts';
import { isTimeframe, TIMEFRAME_LABELS, TIMEFRAME_ORDER } from './timeframes.ts';

/** Symbols offered in the selector (both sources). */
const SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'] as const;
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

type SourceMode = 'replay' | 'api';

/**
 * Dev query parameters (QA links, not persistence):
 * `?source=api` loads canonical history from Fume's backend (default: deterministic replay);
 * `?symbol=` / `?tf=` set the initial selection; `?speed=` the replay speed.
 */
const params = () => new URLSearchParams(window.location.search);

function sourceMode(): SourceMode {
  return params().get('source') === 'api' ? 'api' : 'replay';
}

function isSymbolFor(mode: SourceMode, symbol: string | null): symbol is string {
  return mode === 'replay' ? isReplaySymbol(symbol) : symbol !== null && TICKER.test(symbol);
}

function initialSelection(mode: SourceMode): { symbol: string; timeframe: TimeframeId } {
  const symbol = params().get('symbol');
  const timeframe = params().get('tf');
  return {
    symbol: isSymbolFor(mode, symbol) ? symbol : 'SPY',
    timeframe: isTimeframe(timeframe) ? timeframe : '5m',
  };
}

/** Replay speed (market ms per real ms); `?speed=` for QA. */
function replaySpeed(): number {
  const speed = Number(params().get('speed'));
  return Number.isFinite(speed) && speed > 0 && speed <= 3600 ? speed : 20;
}

function createSource(mode: SourceMode): ChartSource {
  return mode === 'api'
    ? { kind: 'api', client: new FumeHttpClient() }
    : { kind: 'replay', provider: new ReplayMarketDataProvider({ speed: replaySpeed() }) };
}

export function App() {
  const [mode] = useState(sourceMode);
  const [source] = useState(() => createSource(mode));
  const [selection, setSelection] = useState(() => initialSelection(mode));
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const base: readonly string[] = mode === 'replay' ? REPLAY_SYMBOLS : SYMBOLS;
  const symbolOptions = base.includes(selection.symbol) ? base : [...base, selection.symbol];

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Fume</span>
        <label className="symbol-picker">
          <span className="visually-hidden">Symbol</span>
          <select
            aria-label="Symbol"
            value={selection.symbol}
            onChange={(e) => {
              const symbol = e.target.value;
              if (isSymbolFor(mode, symbol)) setSelection((s) => ({ ...s, symbol }));
            }}
          >
            {symbolOptions.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
        </label>
        <div className="timeframes" role="group" aria-label="Timeframe">
          {TIMEFRAME_ORDER.map((timeframe) => (
            <button
              key={timeframe}
              type="button"
              aria-pressed={selection.timeframe === timeframe}
              onClick={() => setSelection((s) => ({ ...s, timeframe }))}
            >
              {TIMEFRAME_LABELS[timeframe]}
            </button>
          ))}
        </div>
        <span className="meta">RTH</span>
        {mode === 'replay' ? (
          <span className="feed" title="Deterministic synthetic replay data. Not real market data.">
            Replay · not live
          </span>
        ) : (
          <span
            className="feed"
            data-testid="feed-label"
            title={
              status?.kind === 'ready'
                ? feedTitle(status.feed)
                : 'Historical candles from the Fume backend'
            }
          >
            {status?.kind === 'ready' ? feedLabel(status.feed) : 'Historical'}
          </span>
        )}
      </header>
      <main className="chart-area">
        <ChartHost
          source={source}
          symbol={selection.symbol}
          timeframe={selection.timeframe}
          onStatus={setStatus}
        />
        {mode === 'api' && status && status.kind !== 'ready' && (
          <div className={`chart-status chart-status-${status.kind}`} role="status">
            {status.kind === 'loading' &&
              `Loading ${status.symbol} ${TIMEFRAME_LABELS[status.timeframe]}…`}
            {status.kind === 'empty' &&
              `No ${TIMEFRAME_LABELS[status.timeframe]} history for ${status.symbol}`}
            {status.kind === 'error' && `${status.symbol}: ${status.message} (${status.code})`}
          </div>
        )}
      </main>
    </div>
  );
}
