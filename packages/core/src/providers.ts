/**
 * Provider ports. Adapters (Alpaca, replay, future futures providers) implement these and
 * translate raw payloads into domain objects at this boundary. Nothing here may reference a
 * specific provider's types, URLs, symbols or field names.
 */
import type { Instrument } from './instrument.ts';
import type {
  Bar,
  DataFeedInfo,
  MarketEvent,
  MarketSession,
  MarketSubscription,
} from './market-data.ts';
import type { ProviderError, ProviderId, UnixMs } from './primitives.ts';
import type { Account, Fill, Order, OrderRequest, Position, TradingEvent } from './trading.ts';

export type StreamState =
  | { status: 'connecting' }
  | { status: 'authenticating' }
  | { status: 'live' }
  | { status: 'reconnecting'; attempt: number; nextRetryAt: UnixMs; lastError?: ProviderError }
  | { status: 'closed'; error?: ProviderError };

/** Structural subset of AbortSignal so core needs no DOM/Workers lib types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

/**
 * Request for provider-native BASE bars. Fume never asks a provider for display timeframes such
 * as 1h or 1d; it builds canonical session-aligned candles from base bars (docs/market-data.md).
 */
export interface BarPageRequest {
  instrument: Instrument;
  /** One of `MarketDataProvider.nativeIntervalsMinutes`. */
  intervalMinutes: number;
  /** Exclusive upper bound on bar start. */
  end: UnixMs;
  /**
   * Optional inclusive lower bound on bar start. When set, the provider returns bars in
   * [start, end); if more than `limit` exist there, the newest `limit` are returned.
   */
  start?: UnixMs;
  limit: number;
  signal?: AbortSignalLike;
}

export interface BarPage {
  /** Ascending by `start`. */
  bars: readonly Bar[];
  /** True when older bars may exist before `bars[0]`. */
  hasMore: boolean;
}

export interface MarketStreamHandlers {
  /**
   * Normalized events in provider arrival order, batched as the provider batches them.
   * Includes `stream_status` and `resync_required` events emitted by the adapter itself.
   * A provider that has no trade feed (bars only) emits provisional `bar` events instead;
   * consumers must work with either.
   */
  onEvents(events: readonly MarketEvent[]): void;
}

export interface MarketStream {
  /**
   * Declarative desired state. The adapter diffs against what the provider has acknowledged
   * and re-applies the full set after every reconnect.
   */
  setSubscriptions(subscriptions: readonly MarketSubscription[]): void;
  close(): void;
}

/**
 * History-only part of the market-data port: instruments, calendar sessions and base bars. A
 * backend history adapter (e.g. Stage 4, before any streaming) implements just this.
 */
export interface HistoricalMarketDataProvider {
  readonly id: ProviderId;
  readonly feed: DataFeedInfo;
  /**
   * Native bar intervals (minutes) this provider serves, each EPOCH-ALIGNED (bucket boundaries at
   * multiples of the interval since the Unix epoch, UTC) and labeled by bucket start.
   * Declare only intervals whose alignment has been verified; `1` is required.
   */
  readonly nativeIntervalsMinutes: readonly number[];
  resolveInstrument(symbol: string): Promise<Instrument | null>;
  getBars(request: BarPageRequest): Promise<BarPage>;
  getSessions(instrument: Instrument, from: UnixMs, to: UnixMs): Promise<readonly MarketSession[]>;
}

/** Full market-data port: history plus the live stream. */
export interface MarketDataProvider extends HistoricalMarketDataProvider {
  openStream(handlers: MarketStreamHandlers): MarketStream;
}

export interface OrderQuery {
  status: 'open' | 'closed' | 'all';
  instrument?: Instrument;
  after?: UnixMs;
  limit?: number;
}

export interface TradingStreamHandlers {
  onEvent(event: TradingEvent): void;
  onState(state: StreamState): void;
}

export interface TradingStream {
  close(): void;
}

/**
 * Brokerage port. The broker is the source of truth; every method returns broker-confirmed state.
 * Methods reject with a ProviderError.
 */
export interface BrokerageProvider {
  readonly id: ProviderId;
  readonly environment: 'paper' | 'live';
  getAccount(): Promise<Account>;
  getPositions(): Promise<readonly Position[]>;
  getPosition(instrument: Instrument): Promise<Position | null>;
  getOrders(query: OrderQuery): Promise<readonly Order[]>;
  getOrderByClientOrderId(clientOrderId: string): Promise<Order | null>;
  getFills(instrument: Instrument, since: UnixMs): Promise<readonly Fill[]>;
  /** Resolves when the broker has ACCEPTED the request; not when it is filled. */
  submitOrder(instrument: Instrument, request: OrderRequest): Promise<Order>;
  /** Resolves when the cancel REQUEST is accepted; the cancellation arrives as a TradingEvent. */
  cancelOrder(orderId: string): Promise<void>;
  /** Submits a closing order and returns it; the position closes only when that order fills. */
  closePosition(instrument: Instrument): Promise<Order>;
  openEventStream(handlers: TradingStreamHandlers): TradingStream;
}
