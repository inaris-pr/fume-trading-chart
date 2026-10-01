import { useEffect, useRef, useState } from 'react';
import type { AssetClass, Instrument, StreamState, TimeframeId } from '@fume/core';
import { FumeApiDataFeed, ReplayDataFeed, type ChartStatus, type DataFeed } from '@fume/datafeed';
import { isReplaySymbol, REPLAY_SYMBOLS } from '@fume/replay';
import {
  FumeChartView,
  type Drawing,
  type DrawingHistoryState,
  type DrawingTool,
  type FumeChartViewHandle,
} from '@fume/react';
import { DrawingList } from './DrawingList.tsx';
import { DrawingProperties } from './DrawingProperties.tsx';
import { DrawingToolbar } from './DrawingToolbar.tsx';
import { feedLabel, feedTitle } from './feed-label.ts';
import { TwoChartProof } from './TwoChartProof.tsx';
import { EQUITY_MENU, FUTURES_MENU, FUTURES_ROOTS, optionText } from './symbol-menu.ts';
import { isTimeframe, TIMEFRAME_LABELS, TIMEFRAME_ORDER } from './timeframes.ts';

/** Equities/ETFs offered with the API source (futures roots: symbol-menu.ts). */
const SYMBOLS: readonly string[] = EQUITY_MENU.map((e) => e.symbol);
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

type SourceMode = 'replay' | 'api';

interface Selection {
  symbol: string;
  assetClass: AssetClass;
  timeframe: TimeframeId;
}

/**
 * Dev query parameters (QA links, not persistence):
 * `?source=api` loads canonical history from Fume's backend (default: deterministic replay);
 * `?proof=two-charts` (with `?source=api`) shows the two-chart embedding proof (NQ 5m + ES 1h on
 * one shared feed and stream connection);
 * `?symbol=` / `?asset=future` / `?tf=` set the initial selection; `?speed=` the replay speed.
 */
const params = () => new URLSearchParams(window.location.search);

function sourceMode(): SourceMode {
  return params().get('source') === 'api' ? 'api' : 'replay';
}

function isFuturesRoot(symbol: string | null): boolean {
  return symbol !== null && FUTURES_ROOTS.includes(symbol);
}

function isSymbolFor(mode: SourceMode, symbol: string | null): symbol is string {
  return mode === 'replay' ? isReplaySymbol(symbol) : symbol !== null && TICKER.test(symbol);
}

function initialSelection(mode: SourceMode): Selection {
  const symbol = params().get('symbol');
  const timeframe = params().get('tf');
  const future = mode === 'api' && params().get('asset') === 'future' && isFuturesRoot(symbol);
  return {
    symbol: future || isSymbolFor(mode, symbol) ? symbol! : 'SPY',
    assetClass: future ? 'future' : 'equity',
    timeframe: isTimeframe(timeframe) ? timeframe : '5m',
  };
}

/** Replay speed (market ms per real ms); `?speed=` for QA. */
function replaySpeed(): number {
  const speed = Number(params().get('speed'));
  return Number.isFinite(speed) && speed > 0 && speed <= 3600 ? speed : 20;
}

/**
 * Replay keeps its long-standing switching behavior: the previous candles stay visible until the
 * new symbol/timeframe is ready (the API source clears at once and shows a loading status).
 */
const REPLAY_SESSION_SETTINGS = { clearOnSwitch: false } as const;

/** The app's wording for the chart's loading/empty/error notice (API source). */
function statusText(status: ChartStatus): string | null {
  switch (status.kind) {
    case 'loading':
      return `Loading ${status.symbol} ${TIMEFRAME_LABELS[status.timeframe]}…`;
    case 'empty':
      return status.streaming
        ? `No delayed data yet for ${status.symbol}`
        : `No ${TIMEFRAME_LABELS[status.timeframe]} history for ${status.symbol}`;
    case 'error':
      return `${status.symbol}: ${status.message} (${status.code})`;
    default:
      return null;
  }
}

/** One DataFeed per page, shared by every chart on it (one stream connection per hub). */
function createFeed(mode: SourceMode): DataFeed {
  return mode === 'api' ? new FumeApiDataFeed() : new ReplayDataFeed({ speed: replaySpeed() });
}

const optionValue = (assetClass: AssetClass, symbol: string) => `${assetClass}:${symbol}`;

/** "NQZ6 · Dec 2026" chip text and tooltip for a specific futures contract. */
function contractInfo(instrument: Instrument): { text: string; title: string } | null {
  const f = instrument.future;
  if (instrument.assetClass !== 'future' || !f) return null;
  const month = instrument.description?.split(' · ').at(-1) ?? f.contractMonth;
  const lastTrade = f.lastTradeTime
    ? new Date(f.lastTradeTime).toLocaleDateString(undefined, {
        timeZone: instrument.session.timezone,
      })
    : null;
  return {
    text: `${instrument.displaySymbol} · ${month}`,
    title: [
      instrument.description ?? instrument.displaySymbol,
      `Contract ${instrument.displaySymbol}`,
      lastTrade ? `last trade ${lastTrade}` : null,
      `tick value ${f.tickValue} ${instrument.currency}`,
      `multiplier ${instrument.contractMultiplier}`,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

const NO_DRAWINGS: readonly Drawing[] = [];
const NO_HISTORY: DrawingHistoryState = { canUndo: false, canRedo: false };

export function App() {
  const [mode] = useState(sourceMode);
  const [feed] = useState(() => createFeed(mode));
  // Dev-only QA handle (stripped from production builds). Set in an effect: StrictMode may call
  // the state initializer twice and keep only one of the feeds.
  const viewRef = useRef<FumeChartViewHandle>(null);
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { __fumeFeed: feed, __fumeView: viewRef });
  }, [feed]);
  const [selection, setSelection] = useState(() => initialSelection(mode));
  const [status, setStatus] = useState<ChartStatus | null>(null);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [tool, setTool] = useState<DrawingTool>('cursor');
  // In memory only (no persistence yet): drawings per instrument, kept across timeframes.
  const [drawings, setDrawings] = useState<Record<string, readonly Drawing[]>>({});
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [history, setHistory] = useState<DrawingHistoryState>(NO_HISTORY);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    // Drawing shortcuts also work while the focus is on the toolbar or the page (not only on the
    // chart). The engine ignores text fields and keys it already handled on its own surface.
    const onKey = (e: KeyboardEvent) => void viewRef.current?.handleKeyDown(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (mode === 'api' && params().get('proof') === 'two-charts') {
    return <TwoChartProof datafeed={feed} />;
  }
  const base: readonly string[] = mode === 'replay' ? REPLAY_SYMBOLS : SYMBOLS;
  const equityOptions =
    selection.assetClass === 'equity' && !base.includes(selection.symbol)
      ? [...base, selection.symbol]
      : base;
  const ready = status?.kind === 'ready' ? status : null;
  const shown =
    status?.kind === 'ready' || status?.kind === 'empty' ? status.instrument : undefined;
  const contract = shown ? contractInfo(shown) : null;
  const streaming = ready?.streaming ?? false;
  const drawingKey = optionValue(selection.assetClass, selection.symbol);
  const shownDrawings = drawings[drawingKey] ?? NO_DRAWINGS;
  const selected = shownDrawings.find((d) => d.id === selectedDrawing) ?? null;

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Fume</span>
        <label className="symbol-picker">
          <span className="visually-hidden">Symbol</span>
          <select
            aria-label="Symbol"
            value={optionValue(selection.assetClass, selection.symbol)}
            onChange={(e) => {
              const [assetClass, symbol] = e.target.value.split(':') as [AssetClass, string];
              if (assetClass === 'future' ? isFuturesRoot(symbol) : isSymbolFor(mode, symbol)) {
                setStream(null);
                setSelection((s) => ({ ...s, symbol, assetClass }));
              }
            }}
          >
            {mode === 'api' ? (
              <>
                <optgroup label="Stocks & ETFs">
                  {equityOptions.map((symbol) => (
                    <option key={symbol} value={optionValue('equity', symbol)}>
                      {optionText(symbol, EQUITY_MENU)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Futures">
                  {FUTURES_MENU.map(({ symbol }) => (
                    <option key={symbol} value={optionValue('future', symbol)}>
                      {optionText(symbol, FUTURES_MENU)}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              equityOptions.map((symbol) => (
                <option key={symbol} value={optionValue('equity', symbol)}>
                  {symbol}
                </option>
              ))
            )}
          </select>
        </label>
        {contract && (
          <span className="contract" data-testid="contract" title={contract.title}>
            {contract.text}
          </span>
        )}
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
        <span className="meta" title="Session shown on the chart">
          {selection.assetClass === 'future' ? 'Full session' : 'RTH'}
        </span>
        {mode === 'replay' ? (
          <span className="feed" title="Deterministic synthetic replay data. Not real market data.">
            Replay · not live
          </span>
        ) : (
          <span
            className={`feed${streaming ? ' feed-streaming' : ''}${ready && ready.feed.delayMs > 0 && streaming ? ' feed-delayed' : ''}`}
            data-testid="feed-label"
            title={
              ready ? feedTitle(ready.feed, streaming, stream) : 'Candles from the Fume backend'
            }
          >
            {ready ? feedLabel(ready.feed, streaming, stream) : 'Historical'}
          </span>
        )}
      </header>
      <div className="workspace">
        <DrawingToolbar
          tool={tool}
          onSelect={(next) => viewRef.current?.setDrawingTool(next)}
          history={history}
          onUndo={() => viewRef.current?.undoDrawing()}
          onRedo={() => viewRef.current?.redoDrawing()}
          drawingCount={shownDrawings.length}
          listOpen={listOpen}
          onToggleList={() => setListOpen((open) => !open)}
        />
        {listOpen && (
          <DrawingList
            drawings={shownDrawings}
            selectedId={selectedDrawing}
            onSelect={(id) => viewRef.current?.selectDrawing(id)}
            onEdit={(id, patch) => viewRef.current?.editDrawing(id, patch)}
            onClose={() => setListOpen(false)}
          />
        )}
        <main className="chart-area">
          <FumeChartView
            ref={viewRef}
            datafeed={feed}
            {...(mode === 'replay' ? { settings: REPLAY_SESSION_SETTINGS } : {})}
            symbol={selection.symbol}
            assetClass={selection.assetClass}
            timeframe={selection.timeframe}
            statusOverlay={mode === 'api' ? statusText : false}
            onStatus={setStatus}
            onStreamState={setStream}
            drawings={shownDrawings}
            onDrawingsChange={(next) => setDrawings((all) => ({ ...all, [drawingKey]: next }))}
            onDrawingToolChange={setTool}
            onDrawingSelectionChange={setSelectedDrawing}
            onDrawingHistoryChange={setHistory}
          />
          {selected && (
            <DrawingProperties
              key={selected.id}
              drawing={selected}
              onEdit={(patch) => viewRef.current?.editDrawing(selected.id, patch)}
              onDuplicate={() => viewRef.current?.duplicateDrawing(selected.id)}
              onDelete={() => viewRef.current?.deleteDrawing(selected.id)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
