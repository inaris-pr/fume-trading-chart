/**
 * Provider-neutral market-data routing (ARCHITECTURE §6.1). Every instrument belongs to exactly one
 * registered FEED: a historical provider (possibly not configured), the asset class it serves, the
 * namespace of the instrument ids it issues, its history floor, and the opaque key of the stream hub
 * that serves it live (null = history only). The router routes by asset class (symbol resolution),
 * by id namespace (loading an instrument) and by `Instrument.marketDataRef.providerId` (bars and
 * sessions). Nothing here names a provider; the composition root registers them.
 */
import type {
  AssetClass,
  DataFeedInfo,
  HistoricalMarketDataProvider,
  Instrument,
  InstrumentId,
  ProviderId,
  UnixMs,
} from '@fume/core';

export interface RegisteredFeed {
  providerId: ProviderId;
  /** Null when the provider is not configured (missing credentials etc.): routes answer 503. */
  provider: HistoricalMarketDataProvider | null;
  /** Feed description, also available when the provider is not configured. */
  feed: DataFeedInfo;
  /** Asset classes whose symbols this feed resolves. */
  assetClasses: readonly AssetClass[];
  /** Prefix of the backend-issued instrument ids this feed creates, e.g. "eq" for "eq:SPY". */
  idNamespace: string;
  /** Oldest bar start the provider serves. */
  historyFloor: () => UnixMs;
  /** Opaque stream-hub key for live data, or null when this feed is history only. */
  streamKey: string | null;
}

export class MarketDataRegistry {
  readonly feeds: readonly RegisteredFeed[];

  constructor(feeds: readonly RegisteredFeed[]) {
    this.feeds = feeds;
  }

  forAssetClass(assetClass: AssetClass): RegisteredFeed | null {
    return this.feeds.find((f) => f.assetClasses.includes(assetClass)) ?? null;
  }

  forInstrumentId(id: InstrumentId | string): RegisteredFeed | null {
    const namespace = id.slice(0, id.indexOf(':'));
    return this.feeds.find((f) => f.idNamespace === namespace) ?? null;
  }

  forInstrument(instrument: Instrument): RegisteredFeed | null {
    return this.feeds.find((f) => f.providerId === instrument.marketDataRef.providerId) ?? null;
  }

  forStreamKey(key: string): RegisteredFeed | null {
    return this.feeds.find((f) => f.streamKey !== null && f.streamKey === key) ?? null;
  }
}
