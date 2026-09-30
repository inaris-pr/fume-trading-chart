/**
 * FeedHub: the provider-neutral core of one provider/feed-scoped stream hub (ARCHITECTURE §6).
 *
 *   one hub (Durable Object) -> ONE upstream stream -> many Fume clients
 *
 * - Subscriptions: each client subscribes instruments by Fume id; the hub keeps the UNION (reference
 *   counted) and applies it declaratively to the single upstream stream. When the union empties, the
 *   upstream closes after an idle grace period (S3: ~60 s), never immediately.
 * - Fan-out: normalized MarketEvents go only to clients subscribed to that instrument.
 * - Recovery: after every upstream (re)connect the hub re-fetches a recent overlap of completed
 *   1-minute bars from the provider's REST history and sends them as authoritative `1m final` bars,
 *   so candles touched by an outage are repaired from the source of truth (no stream replay needed).
 * - Reconstruction: in-memory state is disposable. Client subscriptions live in per-socket
 *   attachments (restored with the sockets), and a connection-conflict hold lives in storage so a
 *   restarted hub never fights another process for a single-connection feed.
 */
import type {
  HistoricalMarketDataProvider,
  Instrument,
  MarketEvent,
  MarketStream,
  StreamState,
  StreamingMarketDataProvider,
  UnixMs,
} from '@fume/core';
import { PROTOCOL_VERSION, parseClientFrame, sanitizeState, type ServerFrame } from './protocol.ts';

const MINUTE = 60_000;
export const DEFAULT_IDLE_CLOSE_MS = 60_000;
export const DEFAULT_RECONCILE_OVERLAP_MS = 30 * MINUTE;
export const DEFAULT_MAX_SUBSCRIPTIONS = 10;
const HOLD_KEY = 'upstreamHoldUntil';

/** One downstream client socket, as the hub sees it. */
export interface HubClient {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Durable per-socket state (survives hub reconstruction where the runtime supports it). */
  getAttachment(): ClientAttachment | null;
  setAttachment(attachment: ClientAttachment): void;
}

export interface ClientAttachment {
  v: 1;
  clientId: string;
  greeted: boolean;
  /** subId -> instrument id */
  subs: Record<string, string>;
}

export interface HubStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface HubTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FeedHubOptions {
  feedKey: string;
  /** A fresh historical provider per operation (each has its own upstream-call budget). */
  historical: () => HistoricalMarketDataProvider;
  streaming: StreamingMarketDataProvider;
  storage: HubStorage;
  now?: () => UnixMs;
  timers?: HubTimers;
  idleCloseMs?: number;
  reconcileOverlapMs?: number;
  maxSubscriptionsPerClient?: number;
  newId?: () => string;
  /** Diagnostics only: never credentials, never market payloads. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface HubDiagnostics {
  clients: number;
  instruments: string[];
  upstream: StreamState['status'];
  upstreamOpen: boolean;
  holdUntil: UnixMs;
  reconciliations: number;
  reconcileFailures: number;
  forwardedEvents: number;
}

interface ClientState {
  attachment: ClientAttachment;
  seq: number;
}

export class FeedHub {
  private readonly o: Required<Omit<FeedHubOptions, 'log'>> & Pick<FeedHubOptions, 'log'>;
  private readonly clients = new Map<HubClient, ClientState>();
  /** instrument id -> { reference count, instrument } */
  private readonly union = new Map<string, { count: number; instrument: Instrument }>();
  private readonly instruments = new Map<string, Instrument>();
  private stream: MarketStream | null = null;
  private streamState: StreamState = { status: 'closed' };
  private idleTimer: unknown = null;
  private holdUntil: UnixMs = 0;
  private reconcileRun = 0;
  private readonly diag = { reconciliations: 0, reconcileFailures: 0, forwardedEvents: 0 };

  constructor(options: FeedHubOptions) {
    this.o = {
      now: Date.now,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      idleCloseMs: DEFAULT_IDLE_CLOSE_MS,
      reconcileOverlapMs: DEFAULT_RECONCILE_OVERLAP_MS,
      maxSubscriptionsPerClient: DEFAULT_MAX_SUBSCRIPTIONS,
      newId: () => crypto.randomUUID(),
      ...options,
    };
  }

  /**
   * Rebuilds state after (re)construction: the persisted conflict hold, then every surviving
   * client socket and its subscriptions (from attachments), then the upstream.
   */
  async restore(clients: readonly HubClient[]): Promise<void> {
    this.holdUntil = (await this.o.storage.get<number>(HOLD_KEY)) ?? 0;
    for (const client of clients) {
      const attachment = client.getAttachment();
      if (!attachment || attachment.v !== 1) {
        client.close(1011, 'hub restarted');
        continue;
      }
      this.clients.set(client, { attachment, seq: 0 });
      for (const id of Object.values(attachment.subs)) {
        const instrument = await this.loadInstrument(id).catch(() => null);
        if (instrument) this.addToUnion(instrument);
      }
    }
    // Restored clients may have missed events while the hub was away.
    for (const [client, state] of this.clients) {
      if (state.attachment.greeted && Object.keys(state.attachment.subs).length > 0) {
        this.send(client, { type: 'resync', scope: 'market', reason: 'server_restart' });
      }
    }
    this.syncUpstream();
  }

  /** A new downstream socket (nothing is sent until the client's hello). */
  connect(client: HubClient): void {
    const attachment: ClientAttachment = {
      v: 1,
      clientId: this.o.newId(),
      greeted: false,
      subs: {},
    };
    client.setAttachment(attachment);
    this.clients.set(client, { attachment, seq: 0 });
  }

  async onMessage(client: HubClient, text: string): Promise<void> {
    const state = this.clients.get(client);
    if (!state) return;
    const frame = parseClientFrame(text);
    if (!frame) {
      this.send(client, { type: 'error', code: 'invalid_request', message: 'Malformed frame' });
      return;
    }
    if (frame.type === 'ping') {
      this.send(client, { type: 'pong', t: frame.t, serverTime: this.o.now() });
      return;
    }
    if (frame.type === 'hello') {
      if (frame.protocol !== PROTOCOL_VERSION) {
        this.send(client, {
          type: 'error',
          code: 'unsupported_protocol',
          message: 'Unsupported protocol',
        });
        client.close(1002, 'unsupported protocol');
        this.onClose(client);
        return;
      }
      state.attachment.greeted = true;
      client.setAttachment(state.attachment);
      this.send(client, {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        serverTime: this.o.now(),
        connectionId: state.attachment.clientId,
        feed: this.o.streaming.feed,
        tradingEnvironment: 'paper',
      });
      this.send(client, { type: 'status', market: sanitizeState(this.streamState) });
      return;
    }
    if (!state.attachment.greeted) {
      this.send(client, { type: 'error', code: 'invalid_request', message: 'hello required' });
      return;
    }
    if (frame.type === 'unsubscribe') {
      this.removeSub(state, frame.subId);
      client.setAttachment(state.attachment);
      this.syncUpstream();
      this.send(client, { type: 'unsubscribed', subId: frame.subId });
      return;
    }
    // subscribe
    const { subId, instrumentId } = frame;
    if (!frame.streams.includes('market')) {
      this.send(client, {
        type: 'error',
        code: 'invalid_request',
        message: 'Only the market stream is available',
        subId,
      });
      return;
    }
    const subs = state.attachment.subs;
    if (!(subId in subs) && Object.keys(subs).length >= this.o.maxSubscriptionsPerClient) {
      this.send(client, {
        type: 'error',
        code: 'symbol_limit',
        message: 'Too many subscriptions',
        subId,
      });
      return;
    }
    let instrument: Instrument | null;
    try {
      instrument = await this.loadInstrument(instrumentId);
    } catch {
      this.send(client, {
        type: 'error',
        code: 'unavailable',
        message: 'Instrument lookup failed',
        subId,
      });
      return;
    }
    if (!this.clients.has(client)) return; // disconnected while loading
    if (!instrument || instrument.marketDataRef.providerId !== this.o.streaming.id) {
      this.send(client, {
        type: 'error',
        code: 'not_found',
        message: 'Unknown instrument for this stream',
        subId,
      });
      return;
    }
    if (subs[subId] !== instrument.id) {
      this.removeSub(state, subId);
      subs[subId] = instrument.id;
      this.addToUnion(instrument);
      client.setAttachment(state.attachment);
    }
    this.syncUpstream();
    this.send(client, { type: 'subscribed', subId, instrumentId: instrument.id });
  }

  onClose(client: HubClient): void {
    const state = this.clients.get(client);
    if (!state) return;
    for (const subId of Object.keys(state.attachment.subs)) this.removeSub(state, subId);
    this.clients.delete(client);
    this.syncUpstream();
  }

  diagnostics(): HubDiagnostics {
    return {
      clients: this.clients.size,
      instruments: [...this.union.keys()].sort(),
      upstream: this.streamState.status,
      upstreamOpen: this.stream !== null,
      holdUntil: this.holdUntil,
      ...this.diag,
    };
  }

  // -------------------------------------------------------------------------------------------

  private async loadInstrument(id: string): Promise<Instrument | null> {
    const cached = this.instruments.get(id);
    if (cached) return cached;
    const provider = this.o.historical();
    const instrument = provider.getInstrument
      ? await provider.getInstrument(id as Instrument['id'])
      : null;
    if (instrument) this.instruments.set(id, instrument);
    return instrument;
  }

  private addToUnion(instrument: Instrument): void {
    const entry = this.union.get(instrument.id);
    if (entry) entry.count++;
    else this.union.set(instrument.id, { count: 1, instrument });
  }

  private removeSub(state: ClientState, subId: string): void {
    const id = state.attachment.subs[subId];
    if (id === undefined) return;
    delete state.attachment.subs[subId];
    const entry = this.union.get(id);
    if (entry && --entry.count <= 0) this.union.delete(id);
  }

  /** Applies the union to the single upstream; opens it on demand, closes it after the idle grace. */
  private syncUpstream(): void {
    if (this.union.size === 0) {
      if (this.stream && this.idleTimer === null) {
        this.idleTimer = this.o.timers.setTimeout(() => {
          this.idleTimer = null;
          if (this.union.size === 0 && this.stream) {
            const stream = this.stream;
            this.stream = null;
            stream.close();
            this.o.log?.({ hub: this.o.feedKey, upstream: 'idle-closed' });
          }
        }, this.o.idleCloseMs);
      }
      this.stream?.setSubscriptions([]);
      return;
    }
    if (this.idleTimer !== null) {
      this.o.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.stream) {
      this.stream = this.o.streaming.openStream(
        { onEvents: (events) => this.onUpstreamEvents(events) },
        this.holdUntil > this.o.now() ? { notBefore: this.holdUntil } : {},
      );
    }
    this.stream.setSubscriptions(
      [...this.union.values()].map(({ instrument }) => ({
        instrumentId: instrument.id,
        channels: this.o.streaming.channels,
        marketDataRef: instrument.marketDataRef,
      })),
    );
  }

  private onUpstreamEvents(events: readonly MarketEvent[]): void {
    const byInstrument = new Map<string, MarketEvent[]>();
    for (const event of events) {
      if (event.kind === 'stream_status') {
        this.onStreamState(event.state);
        continue;
      }
      if (event.kind === 'resync_required') continue; // the live transition reconciles
      const id =
        event.kind === 'trade'
          ? event.trade.instrumentId
          : event.kind === 'quote'
            ? event.quote.instrumentId
            : event.instrumentId;
      const list = byInstrument.get(id);
      if (list) list.push(event);
      else byInstrument.set(id, [event]);
    }
    for (const [id, list] of byInstrument) this.sendToSubscribers(id, list);
  }

  private onStreamState(state: StreamState): void {
    const wasLive = this.streamState.status === 'live';
    this.streamState = state;
    for (const client of this.clients.keys()) {
      this.send(client, { type: 'status', market: sanitizeState(state) });
    }
    if (state.status === 'reconnecting' && state.lastError?.reason === 'connection_conflict') {
      this.holdUntil = state.nextRetryAt;
      void this.o.storage.put(HOLD_KEY, this.holdUntil);
      this.o.log?.({
        hub: this.o.feedKey,
        upstream: 'connection_conflict',
        retryAt: state.nextRetryAt,
      });
    }
    if (state.status === 'live' && !wasLive) {
      if (this.holdUntil !== 0) {
        this.holdUntil = 0;
        void this.o.storage.put(HOLD_KEY, 0);
      }
      void this.reconcile();
    }
  }

  /**
   * Repairs recent candles after an upstream (re)connect: completed 1-minute bars of the last
   * overlap window, from REST, as authoritative `1m final` events. The minute that is still forming
   * (in delayed time) is left to the stream and its own minute aggregate.
   */
  private async reconcile(): Promise<void> {
    const run = ++this.reconcileRun;
    const delayMs = this.o.streaming.feed.delayMs;
    const now = this.o.now();
    const end = Math.floor((now - delayMs) / MINUTE) * MINUTE;
    const start = end - this.o.reconcileOverlapMs;
    for (const { instrument } of [...this.union.values()]) {
      try {
        const page = await this.o.historical().getBars({
          instrument,
          intervalMinutes: 1,
          start,
          end,
          limit: Math.ceil(this.o.reconcileOverlapMs / MINUTE) + 5,
        });
        if (run !== this.reconcileRun || !this.union.has(instrument.id)) continue;
        const events: MarketEvent[] = page.bars
          .filter((b) => b.start + MINUTE <= end)
          .map((bar) => ({
            kind: 'bar',
            instrumentId: instrument.id,
            interval: '1m',
            phase: 'final',
            bar: { ...bar, status: 'final' },
          }));
        this.diag.reconciliations++;
        if (events.length > 0) this.sendToSubscribers(instrument.id, events);
      } catch {
        this.diag.reconcileFailures++;
        this.o.log?.({ hub: this.o.feedKey, reconcile: 'failed' });
        // Fall back to the clients' own tail re-fetch.
        this.sendToSubscribers(instrument.id, null);
      }
    }
  }

  /** `events` null = tell the subscribers to re-fetch the history tail themselves. */
  private sendToSubscribers(instrumentId: string, events: readonly MarketEvent[] | null): void {
    for (const [client, state] of this.clients) {
      if (!Object.values(state.attachment.subs).includes(instrumentId)) continue;
      if (events === null) {
        this.send(client, { type: 'resync', scope: 'market', reason: 'reconcile_failed' });
      } else {
        this.diag.forwardedEvents += events.length;
        this.send(client, { type: 'market', events });
      }
    }
  }

  private send(client: HubClient, frame: ServerFrame): void {
    const state = this.clients.get(client);
    if (!state) return;
    state.seq++;
    try {
      client.send(JSON.stringify({ ...frame, seq: state.seq }));
    } catch {
      this.onClose(client);
    }
  }
}
