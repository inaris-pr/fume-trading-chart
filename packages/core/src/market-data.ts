import type { ProviderSymbolRef } from './instrument.ts';
import type { EventTime, InstrumentId, ProviderId, UnixMs } from './primitives.ts';
import type { StreamState } from './providers.ts';

export type TimeframeId = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Timeframe {
  id: TimeframeId;
  unit: 'minute' | 'hour' | 'day';
  count: number;
}

export const TIMEFRAMES: Readonly<Record<TimeframeId, Timeframe>> = {
  '1m': { id: '1m', unit: 'minute', count: 1 },
  '5m': { id: '5m', unit: 'minute', count: 5 },
  '15m': { id: '15m', unit: 'minute', count: 15 },
  '1h': { id: '1h', unit: 'hour', count: 1 },
  '4h': { id: '4h', unit: 'hour', count: 4 },
  '1d': { id: '1d', unit: 'day', count: 1 },
};

/** Describes the data entitlement behind a series so the UI can label it (e.g. "IEX"). */
export interface DataFeedInfo {
  providerId: ProviderId;
  /** Provider-defined feed name, e.g. "iex". Display/diagnostics only. */
  feedId: string;
  /** false when the feed is a single venue (IEX) rather than consolidated (SIP). */
  consolidated: boolean;
  /**
   * Real-time (0) vs delayed. A delayed feed's newest data is about `delayMs` behind wall-clock
   * time; UIs label it as delayed (never "live") and "latest" means the newest delayed data.
   */
  delayMs: number;
  /** Short neutral display name for the data source, e.g. "IEX", "CME futures". Display only. */
  displayName?: string;
}

/**
 * One OHLCV candle. `start` is the inclusive bucket start. Buckets are SESSION-ALIGNED: anchored
 * at the start of the session window that contains them and clipped at its end, so the last
 * bucket of a window may be shorter (e.g. 1h: 15:30–16:00). The end is therefore
 * min(start + timeframe, window end); daily bars span the session. Bucket starts are whole-second
 * boundaries, so `UnixMs` represents them exactly; adapters reject provider bar timestamps
 * that are not ms-exact.
 */
export interface Bar {
  start: UnixMs;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount?: number;
  vwap?: number;
  /**
   * provisional: still forming (built from trades, or a provider's running bar); may change.
   * final: completed and provider-published; may still be revised later (revision++).
   */
  status: 'provisional' | 'final';
  revision: number;
}

/**
 * Which scheduled session windows a chart/series includes.
 * - regular:  regular trading hours only. MVP default (owner decision Q4).
 * - extended: all scheduled windows (pre/post/overnight). Supported by the architecture; not
 *             exposed in the MVP UI.
 * The instrument's session spec defines what "regular" means (equities: 09:30–16:00 ET;
 * futures: their own windows), so no equity hours are hardcoded.
 */
export type SessionMode = 'regular' | 'extended';

export interface BarSeriesMeta {
  instrumentId: InstrumentId;
  timeframe: TimeframeId;
  sessionMode: SessionMode;
  feed: DataFeedInfo;
}

export interface Trade {
  instrumentId: InstrumentId;
  time: EventTime;
  price: number;
  size: number;
  /** Provider trade id, used for de-duplication together with `venue`. */
  tradeId?: string;
  venue?: string;
  conditions?: readonly string[];
  /**
   * Arrival order assigned by the Fume component that first received the trade (the hub).
   * Tie-breaker only, for trades with identical `time.ns`. Ordering key: (time.ns, ingestSeq).
   */
  ingestSeq?: number;
}

export interface Quote {
  instrumentId: InstrumentId;
  time: EventTime;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

export type SessionPhase = 'pre' | 'regular' | 'post' | 'overnight' | 'closed' | 'halted';

/** One concrete trading day's session, resolved from the calendar (holidays/early closes applied). */
export interface MarketSession {
  instrumentId: InstrumentId;
  /** "YYYY-MM-DD" trading date in the session timezone. */
  sessionDate: string;
  /**
   * Scheduled tradable windows of this session, ascending and non-overlapping, each [start, end).
   * Several windows express scheduled breaks (e.g. a futures maintenance halt) and
   * pre/regular/post segments.
   */
  windows: readonly {
    start: UnixMs;
    end: UnixMs;
    kind: 'pre' | 'regular' | 'post' | 'overnight';
  }[];
}

/**
 * Channels a backend requests from a market-data provider (provider-neutral names).
 * `secondBars` are provider per-second aggregates (for feeds without individual trades).
 */
export type MarketChannel =
  'trades' | 'quotes' | 'secondBars' | 'minuteBars' | 'sessionBar' | 'status';

export interface MarketSubscription {
  instrumentId: InstrumentId;
  channels: readonly MarketChannel[];
  /** The instrument's provider symbol, supplied by the backend so a stream adapter can subscribe. */
  marketDataRef?: ProviderSymbolRef;
}

/**
 * Interval of a provider-level bar event: one second (a provider's per-second aggregate), one
 * minute, or the whole trading session (daily).
 */
export type BarInterval = '1s' | '1m' | 'session';

/**
 * Normalized live market event. This union is both the provider-port output and the payload of
 * the Fume WebSocket `market` frame. Candles for any timeframe are built from these,
 * deterministically, in @fume/core.
 */
export type MarketEvent =
  | { kind: 'trade'; trade: Trade }
  | { kind: 'quote'; quote: Quote }
  | {
      kind: 'bar';
      instrumentId: InstrumentId;
      interval: BarInterval;
      /**
       * provisional: the current, still-forming bar (e.g. a provider's running session bar).
       * final: a completed bar published by the provider.
       * revised: a correction to a previously published final bar.
       * A `1s` bar is a building block of its minute and never official by itself: consumers fold
       * seconds into a provisional minute until the provider's `1m` bar finalizes that minute.
       */
      phase: 'provisional' | 'final' | 'revised';
      bar: Bar;
    }
  | {
      kind: 'instrument_status';
      instrumentId: InstrumentId;
      status: 'trading' | 'halted' | 'unknown';
      time: EventTime;
      reason?: string;
    }
  | { kind: 'stream_status'; state: StreamState }
  | {
      /** Events may have been lost; consumers must re-fetch the history tail and rebuild. */
      kind: 'resync_required';
      instrumentId?: InstrumentId;
      reason: 'stream_reconnected' | 'sequence_gap' | 'server_restart' | 'subscription_changed';
    };
