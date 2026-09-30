/**
 * One multiplexed WebSocket to a Fume stream hub (docs/websocket-api.md), shared by every chart
 * on the page that streams from the same hub. It connects only to Fume's own backend
 * (`<api base>/stream?key=<opaque key>`), never to a market-data provider, and knows nothing about
 * providers: payloads are provider-neutral MarketEvents and StreamStates.
 *
 * - Many subscriptions per socket: each `subscribe()` gets its own subId on the hub (the hub keeps
 *   the upstream union); events are routed to subscriptions by instrument id.
 * - Liveness: ping every 15 s; no server frame for 30 s -> reconnect.
 * - Reconnect: bounded exponential backoff with full jitter (0.5 s .. 30 s, reset after 60 s
 *   stable), then hello + every subscription again; each subscription gets `onResync` once the hub
 *   has re-acknowledged it (events may have been missed).
 * - Every server frame carries `seq` (+1 per frame); any other value -> `onResync` for all.
 * - The socket opens with the first subscription and closes after an idle grace once the last one
 *   is gone (quick symbol switches reuse it).
 */
import type { InstrumentId, MarketEvent, StreamState } from '@fume/core';
import type { LiveHandlers, LiveSubscription } from '../types.ts';

/** The part of the browser WebSocket this connection uses (tests and hosts may pass their own). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Creates the socket for a stream URL. Hosts use it to attach credentials a browser WebSocket can
 * carry (cookies are sent automatically; a token can go in a subprotocol or a query parameter the
 * host's backend accepts).
 */
export type SocketFactory = (url: string) => SocketLike;

export interface StreamTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

export interface StreamConnectionOptions {
  /** Full stream URL (see streamUrl). */
  url: string;
  createSocket?: SocketFactory;
  timers?: StreamTimers;
  random?: () => number;
  /** Close the socket this long after the last subscription ends. Default 30 s. */
  idleCloseMs?: number;
}

export interface StreamConnectionDiagnostics {
  /** Sockets created over the connection's life (reconnects included). */
  socketsCreated: number;
  open: boolean;
  subscriptions: number;
  instruments: string[];
}

const OPEN = 1;
const PING_MS = 15_000;
const SILENCE_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const STABLE_MS = 60_000;
const DEFAULT_IDLE_CLOSE_MS = 30_000;

/**
 * Stream URL for an API base and hub key: relative bases resolve against the page
 * (`/api/v1` -> `ws(s)://<page host>/api/v1/stream?key=…`); absolute bases keep their host.
 */
export function streamUrl(baseUrl: string, key: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/stream`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = new URLSearchParams({ key }).toString();
  return url.toString();
}

const browserTimers: StreamTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

interface Sub {
  instrumentId: InstrumentId;
  handlers: LiveHandlers;
  /** Resync once the hub re-acknowledges this subscription after a reconnect. */
  pendingResync: boolean;
}

export class StreamConnection {
  readonly url: string;
  private readonly createSocket: SocketFactory;
  private readonly timers: StreamTimers;
  private readonly random: () => number;
  private readonly idleCloseMs: number;
  private readonly subs = new Map<string, Sub>();
  private nextSubId = 1;
  private socket: SocketLike | null = null;
  private socketsCreated = 0;
  private welcomed = false;
  private expectedSeq = 1;
  private attempt = 0;
  private everOpened = false;
  private lastFrameAt = 0;
  private openedAt = 0;
  private lastStatus: StreamState | null = null;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private idleTimer: unknown = null;
  private closed = false;

  constructor(options: StreamConnectionOptions) {
    this.url = options.url;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.timers = options.timers ?? browserTimers;
    this.random = options.random ?? Math.random;
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  /** Streams one instrument to `handlers` until `unsubscribe()`. */
  subscribe(instrumentId: InstrumentId, handlers: LiveHandlers): LiveSubscription {
    if (this.closed) return { unsubscribe: () => {} };
    const subId = `s${this.nextSubId++}`;
    this.subs.set(subId, { instrumentId, handlers, pendingResync: false });
    if (this.idleTimer !== null) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.socket && this.retryTimer === null) this.connect();
    else if (this.welcomed) this.sendSubscribe(subId, instrumentId);
    if (this.lastStatus) handlers.onStatus(this.lastStatus);
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.unsubscribe(subId);
      },
    };
  }

  diagnostics(): StreamConnectionDiagnostics {
    return {
      socketsCreated: this.socketsCreated,
      open: this.socket?.readyState === OPEN,
      subscriptions: this.subs.size,
      instruments: [...new Set([...this.subs.values()].map((s) => s.instrumentId))].sort(),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subs.clear();
    this.stopTimers();
    if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.dropSocket(1000, 'closed');
  }

  // -------------------------------------------------------------------------------------------

  private unsubscribe(subId: string): void {
    if (!this.subs.delete(subId)) return;
    if (this.welcomed) this.send({ type: 'unsubscribe', subId });
    if (this.subs.size === 0 && !this.closed && this.idleTimer === null) {
      this.idleTimer = this.timers.setTimeout(() => {
        this.idleTimer = null;
        if (this.subs.size > 0) return;
        this.stopTimers();
        this.dropSocket(1000, 'idle');
      }, this.idleCloseMs);
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.stopTimers();
    this.expectedSeq = 1;
    this.welcomed = false;
    this.broadcastStatus({ status: 'connecting' });
    const socket = this.createSocket(this.url);
    this.socketsCreated++;
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = this.timers.now();
      this.lastFrameAt = this.openedAt;
      this.everOpened = true;
      this.send({ type: 'hello', protocol: 1 });
      this.pingTimer = this.timers.setInterval(() => this.heartbeat(), PING_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === 'string') this.onFrame(event.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.onDisconnected();
    };
    socket.onerror = () => {
      // A close event follows; nothing else to do.
    };
  }

  private onFrame(text: string): void {
    this.lastFrameAt = this.timers.now();
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.seq !== this.expectedSeq) {
      const restarted = frame.seq === 1;
      this.expectedSeq = typeof frame.seq === 'number' ? frame.seq + 1 : this.expectedSeq;
      this.resyncAll(restarted ? 'server_restart' : 'sequence_gap');
    } else {
      this.expectedSeq++;
    }
    switch (frame.type) {
      case 'welcome':
        this.welcomed = true;
        for (const [subId, sub] of this.subs) this.sendSubscribe(subId, sub.instrumentId);
        break;
      case 'subscribed': {
        const sub = typeof frame.subId === 'string' ? this.subs.get(frame.subId) : undefined;
        if (sub?.pendingResync) {
          sub.pendingResync = false;
          sub.handlers.onResync('reconnected');
        }
        break;
      }
      case 'market': {
        const events = Array.isArray(frame.events) ? (frame.events as MarketEvent[]) : [];
        this.route(events);
        break;
      }
      case 'status':
        if (frame.market && typeof frame.market === 'object') {
          this.broadcastStatus(frame.market as StreamState);
        }
        break;
      case 'resync':
        this.resyncAll(String(frame.reason ?? 'resync'));
        break;
      default:
        break;
    }
  }

  /** Delivers each subscription the events of its own instrument (in arrival order). */
  private route(events: readonly MarketEvent[]): void {
    if (events.length === 0) return;
    const byInstrument = new Map<string, MarketEvent[]>();
    for (const e of events) {
      const id = instrumentOf(e);
      if (id === null) continue;
      const list = byInstrument.get(id);
      if (list) list.push(e);
      else byInstrument.set(id, [e]);
    }
    for (const sub of [...this.subs.values()]) {
      const mine = byInstrument.get(sub.instrumentId);
      if (mine) sub.handlers.onEvents(mine);
    }
  }

  private broadcastStatus(state: StreamState): void {
    this.lastStatus = state;
    for (const sub of [...this.subs.values()]) sub.handlers.onStatus(state);
  }

  private resyncAll(reason: string): void {
    for (const sub of [...this.subs.values()]) sub.handlers.onResync(reason);
  }

  private sendSubscribe(subId: string, instrumentId: InstrumentId): void {
    this.send({ type: 'subscribe', subId, instrumentId, streams: ['market'] });
  }

  private heartbeat(): void {
    const now = this.timers.now();
    if (now - this.lastFrameAt > SILENCE_MS) {
      // Silent server: drop and reconnect.
      this.dropSocket(4000, 'silent');
      this.onDisconnected();
      return;
    }
    this.send({ type: 'ping', t: now });
    if (now - this.openedAt > STABLE_MS) this.attempt = 0;
  }

  private onDisconnected(): void {
    this.stopTimers();
    this.socket = null;
    this.welcomed = false;
    if (this.closed || this.subs.size === 0) return;
    if (this.everOpened) for (const sub of this.subs.values()) sub.pendingResync = true;
    this.attempt++;
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.attempt - 1));
    const delay = Math.max(250, Math.round(exp * this.random()));
    this.broadcastStatus({
      status: 'reconnecting',
      attempt: this.attempt,
      nextRetryAt: this.timers.now() + delay,
    });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.subs.size > 0) this.connect();
    }, delay);
  }

  private dropSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    if (socket) {
      socket.onclose = null;
      socket.close(code, reason);
    }
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }
}

function instrumentOf(event: MarketEvent): string | null {
  if (event.kind === 'trade') return event.trade.instrumentId;
  if (event.kind === 'quote') return event.quote.instrumentId;
  if (event.kind === 'bar' || event.kind === 'instrument_status') return event.instrumentId;
  return null;
}
