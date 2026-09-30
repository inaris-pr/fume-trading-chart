/**
 * Public DataFeed contract (docs/embedding.md). A DataFeed is everything a ChartSession needs to
 * show one instrument: symbol resolution, CANONICAL candles per timeframe (session-aligned, as
 * @fume/core builds them), calendar sessions, and optional live events. It is framework-free and
 * provider-neutral: implementations talk to Fume's backend (FumeApiDataFeed), replay a
 * deterministic dataset (ReplayDataFeed), or anything a host builds.
 */
import type {
  AssetClass,
  Bar,
  BarSeriesMeta,
  Instrument,
  InstrumentId,
  MarketEvent,
  MarketSession,
  StreamState,
  TimeframeId,
  UnixMs,
} from '@fume/core';
import type { ChartData, OlderDataRequest, PrependOptions } from '@fume/chart';

export interface ResolvedInstrument {
  instrument: Instrument;
  /** True when `subscribe` delivers live (or delayed) events for this instrument. */
  live: boolean;
}

export interface ResolveOptions {
  /** `equity` (default; ETFs included) or `future` (a root such as "NQ" -> a specific contract). */
  assetClass?: AssetClass;
  signal?: AbortSignal;
}

export interface BarsQuery {
  instrumentId: InstrumentId;
  timeframe: TimeframeId;
  /** Exclusive upper bound on candle start; omit for the latest candles. */
  end?: UnixMs;
  /**
   * Requested page size in candles. A feed may page differently (e.g. by whole trading sessions,
   * never splitting one); callers continue from the oldest returned candle either way.
   */
  limit: number;
  signal?: AbortSignal;
}

export interface BarsPage {
  meta: BarSeriesMeta;
  /** Canonical candles, ascending, unique starts, all < `end`. */
  bars: Bar[];
  /** True while older candles may exist. */
  hasMore: boolean;
  /** The feed's "now" (wall clock for a backend, market clock for a replay). */
  serverTime: UnixMs;
}

export interface LiveHandlers {
  /** Normalized events for the subscribed instrument (trades and/or 1s/1m bars). */
  onEvents(events: readonly MarketEvent[]): void;
  /** Health of the live connection. */
  onStatus(state: StreamState): void;
  /** Events may have been missed: re-fetch the tail and rebuild live state. */
  onResync(reason: string): void;
}

export interface LiveSubscription {
  unsubscribe(): void;
}

export interface DataFeed {
  resolveInstrument(symbol: string, options?: ResolveOptions): Promise<ResolvedInstrument>;
  getBars(query: BarsQuery): Promise<BarsPage>;
  getSessions(
    instrumentId: InstrumentId,
    from: UnixMs,
    to: UnixMs,
    signal?: AbortSignal,
  ): Promise<MarketSession[]>;
  /** Live events for one instrument; null when the feed has none for it (history only). */
  subscribe(instrumentId: InstrumentId, handlers: LiveHandlers): LiveSubscription | null;
  /** Releases connections and timers. The feed must not be used afterwards. */
  dispose(): void;
}

/** Error thrown by feeds: a stable `code` plus a human-readable message (never provider text). */
export class DataFeedError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** Provider-neutral detail, e.g. "contract_expired", when the backend supplied one. */
  readonly reason: string | undefined;

  constructor(code: string, message: string, retryable = false, reason?: string) {
    super(message);
    this.name = 'DataFeedError';
    this.code = code;
    this.retryable = retryable;
    this.reason = reason;
  }
}

/** The subset of FumeChart a ChartSession drives (tests pass a recorder). */
export interface ChartSink {
  setData(data: ChartData): void;
  upsertBars(bars: readonly Bar[]): unknown;
  prependBars(bars: readonly Bar[], options?: PrependOptions): unknown;
  resolveOlderDataRequest(hasMore: boolean): void;
}

export type { OlderDataRequest };
