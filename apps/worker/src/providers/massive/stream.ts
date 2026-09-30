/**
 * Massive futures delayed WebSocket adapter: implements the core StreamingMarketDataProvider port.
 *
 * Upstream protocol (observed 2026-09-30, docs/research.md): `status connected` -> send
 * {"action":"auth","params":<key>} -> `status auth_success` -> subscribe "A.<contract>,AM.<contract>"
 * (per-second and per-minute aggregates; Starter has no trades or quotes). Messages are JSON
 * arrays; o/h/l/c/dv arrive as numeric strings; s/e are epoch ms.
 *
 * Normalized output (provider-neutral MarketEvents):
 *   A  -> { kind: 'bar', interval: '1s', phase: 'provisional' }  (builds the delayed current minute)
 *   AM -> { kind: 'bar', interval: '1m', phase: 'final' }        (authoritative minute)
 *   plus stream_status on every state change and resync_required after a reconnect.
 *
 * Single-connection feed: a second connection with the same key displaces the older one
 * (`status max_connections`, close 1008). That is surfaced as reason `connection_conflict` with a
 * long, bounded backoff: the adapter never fights another process for the feed.
 *
 * The key is sent only inside the auth frame; it is never logged or included in any event.
 */
import type {
  DataFeedInfo,
  InstrumentId,
  MarketChannel,
  MarketEvent,
  MarketStream,
  MarketStreamHandlers,
  MarketSubscription,
  OpenStreamOptions,
  ProviderError,
  StreamState,
  StreamingMarketDataProvider,
  UnixMs,
} from '@fume/core';
import type { UpstreamConnector, UpstreamSocket } from '../../hub/upstream.ts';
import { MASSIVE_PROVIDER_ID } from './config.ts';
import { checkAggregate, isRecord } from './normalize.ts';

export interface StreamTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MassiveStreamOptions {
  url: string;
  apiKey: string;
  feed: DataFeedInfo;
  connect: UpstreamConnector;
  now?: () => UnixMs;
  timers?: StreamTimers;
  /** [0, 1) jitter source (tests pass a constant). */
  random?: () => number;
  /** Diagnostics only (never the key, never raw payloads). */
  log?: (entry: Record<string, unknown>) => void;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
/** Normal reconnect backoff: 1 s doubling to 30 s, with jitter; reset after 60 s stable. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_MS = 60_000;
/** Connection conflict (max_connections): 60 s doubling to 15 min. */
const CONFLICT_BASE_MS = 60_000;
const CONFLICT_MAX_MS = 15 * MINUTE_MS;
/** Rejected credentials: 5 min doubling to 30 min (a fixed key needs a human). */
const AUTH_BASE_MS = 5 * MINUTE_MS;
const AUTH_MAX_MS = 30 * MINUTE_MS;
/** Handshake (connected + auth_success) must complete within this time. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

const REAL_TIMERS: StreamTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class MassiveFuturesStreamProvider implements StreamingMarketDataProvider {
  readonly id = MASSIVE_PROVIDER_ID;
  readonly feed: DataFeedInfo;
  readonly channels: readonly MarketChannel[] = ['secondBars', 'minuteBars'];
  private readonly options: MassiveStreamOptions;

  constructor(options: MassiveStreamOptions) {
    this.options = options;
    this.feed = options.feed;
  }

  openStream(
    handlers: MarketStreamHandlers,
    options: OpenStreamOptions = {},
  ): MassiveStreamSession {
    return new MassiveStreamSession(this.options, handlers, options);
  }
}

type Failure = 'disconnect' | 'conflict' | 'auth';

export interface MassiveStreamDiagnostics {
  connects: number;
  reconnects: number;
  conflicts: number;
  authFailures: number;
  secondBars: number;
  minuteBars: number;
  malformed: number;
  unknownSymbols: number;
  statusErrors: number;
}

export class MassiveStreamSession implements MarketStream {
  private readonly o: Required<Omit<MassiveStreamOptions, 'log'>> &
    Pick<MassiveStreamOptions, 'log'>;
  private readonly handlers: MarketStreamHandlers;
  /** Desired provider symbol -> Fume instrument id. */
  private desired = new Map<string, InstrumentId>();
  /** Symbols subscribed on the current socket. */
  private acked = new Set<string>();
  private socket: UpstreamSocket | null = null;
  private socketId = 0;
  private phase: 'idle' | 'connecting' | 'authenticating' | 'live' | 'waiting' | 'closed' = 'idle';
  private timer: unknown = null;
  private handshakeTimer: unknown = null;
  private liveSince: UnixMs | null = null;
  private everLive = false;
  private attempts = { disconnect: 0, conflict: 0, auth: 0 };
  private pendingFailure: Failure | null = null;
  private readonly diag: MassiveStreamDiagnostics = {
    connects: 0,
    reconnects: 0,
    conflicts: 0,
    authFailures: 0,
    secondBars: 0,
    minuteBars: 0,
    malformed: 0,
    unknownSymbols: 0,
    statusErrors: 0,
  };

  constructor(
    options: MassiveStreamOptions,
    handlers: MarketStreamHandlers,
    open: OpenStreamOptions,
  ) {
    this.o = {
      now: Date.now,
      timers: REAL_TIMERS,
      random: Math.random,
      ...options,
    };
    this.handlers = handlers;
    const now = this.o.now();
    if (open.notBefore !== undefined && open.notBefore > now) {
      // A persisted conflict hold: wait before touching the feed.
      this.attempts.conflict = 1;
      this.waitAndReconnect(open.notBefore - now, 'conflict');
    } else {
      void this.connect();
    }
  }

  diagnostics(): Readonly<MassiveStreamDiagnostics> {
    return { ...this.diag };
  }

  setSubscriptions(subscriptions: readonly MarketSubscription[]): void {
    const next = new Map<string, InstrumentId>();
    for (const s of subscriptions) {
      const ref = s.marketDataRef;
      if (!ref || ref.providerId !== MASSIVE_PROVIDER_ID) continue;
      if (!s.channels.some((c) => c === 'secondBars' || c === 'minuteBars')) continue;
      next.set(ref.symbol, s.instrumentId);
    }
    this.desired = next;
    if (this.phase === 'live') this.applySubscriptions();
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.socketId++;
    try {
      socket?.close(1000, 'closed by hub');
    } catch {
      // already closed
    }
    this.emit([{ kind: 'stream_status', state: { status: 'closed' } }]);
  }

  // -------------------------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.phase === 'closed') return;
    this.phase = 'connecting';
    this.pendingFailure = null;
    const id = ++this.socketId;
    this.diag.connects++;
    if (this.everLive) this.diag.reconnects++;
    this.emit([{ kind: 'stream_status', state: { status: 'connecting' } }]);
    this.handshakeTimer = this.o.timers.setTimeout(() => {
      if (id === this.socketId && this.phase !== 'live') this.dropSocket('disconnect');
    }, HANDSHAKE_TIMEOUT_MS);
    let socket: UpstreamSocket;
    try {
      socket = await this.o.connect(this.o.url, {
        onMessage: (text) => {
          if (id === this.socketId) this.onMessage(text);
        },
        onClose: (code) => {
          if (id === this.socketId) this.onSocketClosed(code);
        },
      });
    } catch {
      if (id === this.socketId && this.currentPhase() !== 'closed') this.onSocketClosed(1006);
      return;
    }
    if (id !== this.socketId || this.currentPhase() === 'closed') {
      try {
        socket.close(1000, 'superseded');
      } catch {
        // ignore
      }
      return;
    }
    this.socket = socket;
    this.acked.clear();
    // The greeting may have been delivered before the connector resolved.
    if (this.currentPhase() === 'authenticating') {
      this.send({ action: 'auth', params: this.o.apiKey });
    }
  }

  /** Reads the phase without control-flow narrowing (it changes across awaits and callbacks). */
  private currentPhase(): MassiveStreamSession['phase'] {
    return this.phase;
  }

  private onMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.diag.malformed++;
      return;
    }
    const events: MarketEvent[] = [];
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isRecord(msg)) {
        this.diag.malformed++;
        continue;
      }
      if (msg.ev === 'status') this.onStatus(msg);
      else if (msg.ev === 'A' || msg.ev === 'AM') {
        const event = this.toBarEvent(msg);
        if (event) events.push(event);
      }
    }
    if (events.length > 0) this.emit(events);
  }

  private onStatus(msg: Record<string, unknown>): void {
    const status = typeof msg.status === 'string' ? msg.status : '';
    switch (status) {
      case 'connected':
        if (this.phase === 'connecting') {
          this.phase = 'authenticating';
          this.emit([{ kind: 'stream_status', state: { status: 'authenticating' } }]);
          // Sent now if the socket is known, otherwise as soon as the connector resolves.
          if (this.socket) this.send({ action: 'auth', params: this.o.apiKey });
        }
        return;
      case 'auth_success':
        this.onLive();
        return;
      case 'auth_failed':
        this.diag.authFailures++;
        this.dropSocket('auth');
        return;
      case 'max_connections':
        this.diag.conflicts++;
        this.dropSocket('conflict');
        return;
      case 'success':
        return;
      default:
        this.diag.statusErrors++;
        this.o.log?.({ stream: 'massive', status: status.slice(0, 32) });
    }
  }

  private onLive(): void {
    if (this.phase === 'closed') return;
    this.o.timers.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const reconnected = this.everLive;
    this.phase = 'live';
    this.everLive = true;
    this.liveSince = this.o.now();
    this.acked.clear();
    this.applySubscriptions();
    this.emit([
      { kind: 'stream_status', state: { status: 'live' } },
      ...(reconnected
        ? [{ kind: 'resync_required', reason: 'stream_reconnected' } as MarketEvent]
        : []),
    ]);
    // Reset the backoff once the connection has proven stable.
    const since = this.liveSince;
    this.timer = this.o.timers.setTimeout(() => {
      if (this.phase === 'live' && this.liveSince === since) {
        this.attempts.disconnect = 0;
        this.attempts.auth = 0;
        this.attempts.conflict = 0;
      }
    }, STABLE_MS);
  }

  private applySubscriptions(): void {
    const add = [...this.desired.keys()].filter((s) => !this.acked.has(s));
    const remove = [...this.acked].filter((s) => !this.desired.has(s));
    if (remove.length > 0) {
      this.send({
        action: 'unsubscribe',
        params: remove.flatMap((s) => [`A.${s}`, `AM.${s}`]).join(','),
      });
      for (const s of remove) this.acked.delete(s);
    }
    if (add.length > 0) {
      this.send({
        action: 'subscribe',
        params: add.flatMap((s) => [`A.${s}`, `AM.${s}`]).join(','),
      });
      for (const s of add) this.acked.add(s);
    }
  }

  private toBarEvent(msg: Record<string, unknown>): MarketEvent | null {
    const second = msg.ev === 'A';
    const sym = typeof msg.sym === 'string' ? msg.sym : '';
    const instrumentId = this.desired.get(sym);
    if (!instrumentId) {
      this.diag.unknownSymbols++;
      return null;
    }
    const width = second ? SECOND_MS : MINUTE_MS;
    const s = typeof msg.s === 'number' ? msg.s : null;
    const e = typeof msg.e === 'number' ? msg.e : null;
    try {
      if (s === null || e === null || e - s !== width) throw new Error('window');
      const fields = checkAggregate(
        {
          start: s,
          open: msg.o,
          high: msg.h,
          low: msg.l,
          close: msg.c,
          volume: msg.v,
          trades: msg.n,
        },
        width,
      );
      if (second) this.diag.secondBars++;
      else this.diag.minuteBars++;
      return {
        kind: 'bar',
        instrumentId,
        interval: second ? '1s' : '1m',
        phase: second ? 'provisional' : 'final',
        bar: { ...fields, status: second ? 'provisional' : 'final', revision: 0 },
      };
    } catch {
      this.diag.malformed++;
      return null;
    }
  }

  private send(frame: unknown): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      this.dropSocket('disconnect');
    }
  }

  /** Closes the current socket deliberately and schedules the reconnect for `failure`. */
  private dropSocket(failure: Failure): void {
    if (this.phase === 'closed' || this.phase === 'waiting') return;
    this.pendingFailure = failure;
    const socket = this.socket;
    this.socket = null;
    this.socketId++;
    try {
      socket?.close(1000, 'reconnecting');
    } catch {
      // ignore
    }
    this.scheduleReconnect(failure);
  }

  private onSocketClosed(code: number): void {
    if (this.phase === 'closed' || this.phase === 'waiting') return;
    this.socket = null;
    this.socketId++;
    // 1008 without a status frame is also the conflict signal.
    const failure: Failure = this.pendingFailure ?? (code === 1008 ? 'conflict' : 'disconnect');
    if (failure === 'conflict' && this.pendingFailure === null) this.diag.conflicts++;
    this.scheduleReconnect(failure);
  }

  private scheduleReconnect(failure: Failure): void {
    const n = ++this.attempts[failure];
    const [base, max] =
      failure === 'conflict'
        ? [CONFLICT_BASE_MS, CONFLICT_MAX_MS]
        : failure === 'auth'
          ? [AUTH_BASE_MS, AUTH_MAX_MS]
          : [BACKOFF_BASE_MS, BACKOFF_MAX_MS];
    const exp = Math.min(max, base * 2 ** (n - 1));
    // Full jitter for ordinary disconnects; conflicts and auth failures wait at least `exp`.
    const delay = failure === 'disconnect' ? Math.max(250, Math.round(exp * this.o.random())) : exp;
    this.waitAndReconnect(delay, failure);
  }

  private waitAndReconnect(delayMs: number, failure: Failure): void {
    this.clearTimers();
    this.phase = 'waiting';
    this.liveSince = null;
    this.acked.clear();
    const nextRetryAt = this.o.now() + delayMs;
    this.emit([
      {
        kind: 'stream_status',
        state: {
          status: 'reconnecting',
          attempt: this.attempts[failure],
          nextRetryAt,
          lastError: failureError(failure),
        } satisfies StreamState,
      },
    ]);
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null;
      if (this.phase === 'waiting') void this.connect();
    }, delayMs);
  }

  private clearTimers(): void {
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
    if (this.handshakeTimer !== null) this.o.timers.clearTimeout(this.handshakeTimer);
    this.timer = null;
    this.handshakeTimer = null;
  }

  private emit(events: readonly MarketEvent[]): void {
    this.handlers.onEvents(events);
  }
}

function failureError(failure: Failure): ProviderError {
  switch (failure) {
    case 'conflict':
      return {
        code: 'unavailable',
        message: 'The feed connection was taken over by another connection',
        retryable: true,
        reason: 'connection_conflict',
        providerCode: 'max_connections',
      };
    case 'auth':
      return {
        code: 'unauthorized',
        message: 'The feed rejected the backend credentials',
        retryable: true,
        reason: 'auth_failed',
      };
    default:
      return {
        code: 'unavailable',
        message: 'The feed connection was lost',
        retryable: true,
        reason: 'upstream_disconnected',
      };
  }
}
