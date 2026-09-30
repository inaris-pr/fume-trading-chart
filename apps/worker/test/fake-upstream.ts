/**
 * Test doubles for the stream layer: a manual clock + timer queue, and a scripted fake of the
 * Massive delayed WebSocket (greeting, auth, subscribe acks, max_connections). No network.
 */
import type { UpstreamConnector, UpstreamSocketHandlers } from '../src/hub/upstream.ts';

export class ManualClock {
  now: number;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  constructor(start: number) {
    this.now = start;
  }

  readonly timers = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = this.nextId++;
      this.queue.push({ at: this.now + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.queue = this.queue.filter((t) => t.id !== handle);
    },
  };

  /** Advances time, running due timers in order (timers may schedule more timers). */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > target) break;
      this.queue.shift();
      this.now = next.at;
      next.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }

  pending(): number {
    return this.queue.length;
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

export interface FakeConnection {
  url: string;
  sent: unknown[];
  handlers: UpstreamSocketHandlers;
  closed: { code?: number; reason?: string } | null;
  /** Server -> adapter frame (JSON-encoded array). */
  push(...messages: unknown[]): void;
  /** Server closes the socket. */
  drop(code?: number, reason?: string): void;
}

export interface FakeMassiveSocketOptions {
  /** Reply to auth with auth_failed. */
  rejectAuth?: boolean;
  /** Do not greet automatically. */
  silent?: boolean;
  /** Connection attempts fail (connector rejects). */
  refuse?: boolean;
}

/** Scripted Massive delayed futures socket server. */
export class FakeMassiveSocketServer {
  readonly connections: FakeConnection[] = [];
  options: FakeMassiveSocketOptions;
  private readonly key: string;

  constructor(key: string, options: FakeMassiveSocketOptions = {}) {
    this.key = key;
    this.options = options;
  }

  get open(): FakeConnection[] {
    return this.connections.filter((c) => c.closed === null);
  }

  readonly connect: UpstreamConnector = async (url, handlers) => {
    if (this.options.refuse) throw new Error('refused');
    const conn: FakeConnection = {
      url,
      sent: [],
      handlers,
      closed: null,
      push: (...messages) => {
        if (conn.closed === null) handlers.onMessage(JSON.stringify(messages));
      },
      drop: (code = 1006, reason = '') => {
        if (conn.closed !== null) return;
        conn.closed = { code, reason };
        handlers.onClose(code, reason);
      },
    };
    this.connections.push(conn);
    const socket = {
      send: (text: string) => {
        if (conn.closed !== null) return;
        const frame = JSON.parse(text) as { action: string; params: string };
        conn.sent.push(frame);
        if (frame.action === 'auth') {
          if (this.options.rejectAuth || frame.params !== this.key) {
            conn.push({ ev: 'status', status: 'auth_failed', message: 'authentication failed' });
          } else {
            conn.push({ ev: 'status', status: 'auth_success', message: 'authenticated' });
          }
        } else if (frame.action === 'subscribe') {
          conn.push(
            ...frame.params
              .split(',')
              .map((p) => ({ ev: 'status', status: 'success', message: `subscribed to: ${p}` })),
          );
        }
      },
      close: (code?: number, reason?: string) => {
        if (conn.closed === null)
          conn.closed = {
            ...(code !== undefined ? { code } : {}),
            ...(reason !== undefined ? { reason } : {}),
          };
      },
    };
    if (!this.options.silent) {
      queueMicrotask(() =>
        conn.push({ ev: 'status', status: 'connected', message: 'Connected Successfully' }),
      );
    }
    return socket;
  };

  /** Another process with the same key connected: the OLDEST connection is displaced. */
  displaceOldest(): void {
    const oldest = this.open[0];
    if (!oldest) return;
    oldest.push({
      ev: 'status',
      status: 'max_connections',
      message: 'Maximum number of websocket connections exceeded.',
    });
    oldest.drop(1008, '');
  }
}

/** A per-second aggregate as the delayed feed sends it (string prices). */
export function wsSecond(
  sym: string,
  s: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
) {
  return {
    ev: 'A',
    sym,
    v,
    dv: String(o * v),
    n: 1,
    o: String(o),
    c: String(c),
    h: String(h),
    l: String(l),
    s,
    e: s + 1000,
  };
}

export function wsMinute(
  sym: string,
  s: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
) {
  return {
    ev: 'AM',
    sym,
    v,
    dv: String(o * v),
    n: 3,
    o: String(o),
    c: String(c),
    h: String(h),
    l: String(l),
    s,
    e: s + 60_000,
  };
}
