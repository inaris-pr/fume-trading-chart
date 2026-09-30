/**
 * FumeApiDataFeed: the DataFeed for Fume's backend (`/api/v1` HTTP + `/api/v1/stream`).
 *
 * - History, sessions and symbol resolution over HTTP (FumeHttpClient).
 * - Live data through ONE multiplexed StreamConnection per stream-hub key: every chart that uses
 *   this feed instance shares it (share one feed instance per page).
 * - Configurable for embedding: API base URL, fetch, an auth hook for HTTP headers, and a
 *   WebSocket factory (the place to attach stream credentials).
 */
import type { InstrumentId, MarketSession, UnixMs } from '@fume/core';
import type {
  BarsPage,
  BarsQuery,
  DataFeed,
  LiveHandlers,
  LiveSubscription,
  ResolveOptions,
  ResolvedInstrument,
} from '../types.ts';
import { FumeHttpClient, type AuthHook, type FetchLike } from './http-client.ts';
import {
  StreamConnection,
  streamUrl,
  type SocketFactory,
  type StreamConnectionDiagnostics,
  type StreamTimers,
} from './stream-connection.ts';

export interface FumeApiDataFeedOptions {
  /** API base, relative ("/api/v1", default) or absolute ("https://fume.example/api/v1"). */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Headers for every HTTP request (e.g. the host's bearer token). */
  getAuthHeaders?: AuthHook;
  /** Creates stream sockets (default: the browser WebSocket). */
  createWebSocket?: SocketFactory;
  /** Stream URL builder override (default: `<baseUrl>/stream?key=<key>` on the page origin). */
  streamUrl?: (baseUrl: string, key: string) => string;
  /** Test hooks. */
  timers?: StreamTimers;
  random?: () => number;
  idleCloseMs?: number;
}

export class FumeApiDataFeed implements DataFeed {
  readonly http: FumeHttpClient;
  private readonly options: FumeApiDataFeedOptions;
  /** Stream key per resolved instrument (null = history only). */
  private readonly streamKeys = new Map<InstrumentId, string | null>();
  /** One multiplexed connection per stream-hub key. */
  private readonly connections = new Map<string, StreamConnection>();
  private disposed = false;

  constructor(options: FumeApiDataFeedOptions = {}) {
    this.options = options;
    this.http = new FumeHttpClient({
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.getAuthHeaders ? { getAuthHeaders: options.getAuthHeaders } : {}),
    });
  }

  async resolveInstrument(
    symbol: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedInstrument> {
    const { instrument, streamKey } = await this.http.resolveInstrument(
      symbol,
      options.signal,
      options.assetClass ?? 'equity',
    );
    this.streamKeys.set(instrument.id, streamKey);
    return { instrument, live: streamKey !== null };
  }

  getBars(query: BarsQuery): Promise<BarsPage> {
    return this.http.getBars(query);
  }

  getSessions(
    instrumentId: InstrumentId,
    from: UnixMs,
    to: UnixMs,
    signal?: AbortSignal,
  ): Promise<MarketSession[]> {
    return this.http.getSessions(instrumentId, from, to, signal);
  }

  subscribe(instrumentId: InstrumentId, handlers: LiveHandlers): LiveSubscription | null {
    if (this.disposed) return null;
    const key = this.streamKeys.get(instrumentId) ?? null;
    if (key === null) return null;
    let connection = this.connections.get(key);
    if (!connection) {
      const url = (this.options.streamUrl ?? streamUrl)(this.http.baseUrl, key);
      connection = new StreamConnection({
        url,
        ...(this.options.createWebSocket ? { createSocket: this.options.createWebSocket } : {}),
        ...(this.options.timers ? { timers: this.options.timers } : {}),
        ...(this.options.random ? { random: this.options.random } : {}),
        ...(this.options.idleCloseMs !== undefined
          ? { idleCloseMs: this.options.idleCloseMs }
          : {}),
      });
      this.connections.set(key, connection);
    }
    return connection.subscribe(instrumentId, handlers);
  }

  /** Stream connections by hub key (diagnostics and the two-chart proof). */
  streamDiagnostics(): Record<string, StreamConnectionDiagnostics> {
    return Object.fromEntries([...this.connections].map(([k, c]) => [k, c.diagnostics()]));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}
