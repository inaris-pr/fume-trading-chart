/**
 * StreamConnection (multiplexed) with a fake socket and manual timers: URL building, many
 * subscriptions on ONE socket, per-instrument routing, idle close, seq gaps -> resync, silence ->
 * reconnect with bounded backoff -> resubscribe all -> resync per subscription. No network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InstrumentId, MarketEvent, StreamState } from '@fume/core';
import { StreamConnection, streamUrl, type SocketLike } from '../src/api/stream-connection.ts';
import type { LiveHandlers } from '../src/types.ts';

const NQ = 'fut:NQ:2026-12' as InstrumentId;
const ES = 'fut:ES:2026-12' as InstrumentId;

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private seq = 0;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serve(frame: Record<string, unknown>, seq?: number) {
    this.seq = seq ?? this.seq + 1;
    this.onmessage?.({ data: JSON.stringify({ ...frame, seq: this.seq }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  /** Replies `welcome` and then `subscribed` for every subscribe frame sent so far. */
  ack() {
    for (const f of this.sent) {
      if (f.type === 'subscribe')
        this.serve({ type: 'subscribed', subId: f.subId, instrumentId: f.instrumentId });
    }
  }
}

let now = 0;
let timers: { at: number; fn: () => void; every?: number; id: number }[] = [];
let nextId = 1;
const manual = {
  setTimeout: (fn: () => void, ms: number) => {
    timers.push({ at: now + ms, fn, id: nextId });
    return nextId++;
  },
  clearTimeout: (id: unknown) => void (timers = timers.filter((t) => t.id !== id)),
  setInterval: (fn: () => void, ms: number) => {
    timers.push({ at: now + ms, fn, every: ms, id: nextId });
    return nextId++;
  },
  clearInterval: (id: unknown) => void (timers = timers.filter((t) => t.id !== id)),
  now: () => now,
};
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > end) break;
    now = t.at;
    if (t.every) t.at += t.every;
    else timers.shift();
    t.fn();
  }
  now = end;
}

class Recorder implements LiveHandlers {
  events: MarketEvent[] = [];
  states: StreamState[] = [];
  resyncs: string[] = [];
  onEvents(e: readonly MarketEvent[]) {
    this.events.push(...e);
  }
  onStatus(s: StreamState) {
    this.states.push(s);
  }
  onResync(r: string) {
    this.resyncs.push(r);
  }
}

function setup(idleCloseMs = 30_000) {
  const sockets: FakeSocket[] = [];
  const conn = new StreamConnection({
    url: 'ws://localhost:5173/api/v1/stream?key=futures-delayed',
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timers: manual,
    random: () => 0.5,
    idleCloseMs,
  });
  return { conn, sockets };
}

beforeEach(() => {
  now = 1_000_000;
  timers = [];
  vi.stubGlobal('location', {
    href: 'http://localhost:5173/?source=api',
    host: 'localhost:5173',
    protocol: 'http:',
  });
});
afterEach(() => vi.unstubAllGlobals());

const bar = (id: InstrumentId): MarketEvent => ({
  kind: 'bar',
  instrumentId: id,
  interval: '1s',
  phase: 'provisional',
  bar: {
    start: 0,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    status: 'provisional',
    revision: 0,
  },
});

describe('streamUrl', () => {
  test('relative bases resolve on the page origin; absolute bases keep their host', () => {
    expect(streamUrl('/api/v1', 'futures-delayed')).toBe(
      'ws://localhost:5173/api/v1/stream?key=futures-delayed',
    );
    expect(streamUrl('https://fume.example/api/v1/', 'k')).toBe(
      'wss://fume.example/api/v1/stream?key=k',
    );
    vi.stubGlobal('location', {
      href: 'https://app.example/x',
      host: 'app.example',
      protocol: 'https:',
    });
    expect(streamUrl('/api/v1', 'k')).toBe('wss://app.example/api/v1/stream?key=k');
  });
});

describe('multiplexing', () => {
  test('two instruments share ONE socket; each gets only its own events; status goes to both', () => {
    const { conn, sockets } = setup();
    const nq = new Recorder();
    const es = new Recorder();
    conn.subscribe(NQ, nq);
    conn.subscribe(ES, es);
    expect(sockets).toHaveLength(1);
    const s = sockets[0]!;
    s.open();
    s.serve({ type: 'welcome' });
    expect(s.sent).toEqual([
      { type: 'hello', protocol: 1 },
      { type: 'subscribe', subId: 's1', instrumentId: NQ, streams: ['market'] },
      { type: 'subscribe', subId: 's2', instrumentId: ES, streams: ['market'] },
    ]);
    s.ack();
    s.serve({ type: 'market', events: [bar(NQ), bar(ES), bar(NQ)] });
    expect(nq.events).toEqual([bar(NQ), bar(NQ)]);
    expect(es.events).toEqual([bar(ES)]);
    s.serve({ type: 'status', market: { status: 'live' } });
    expect(nq.states.at(-1)).toEqual({ status: 'live' });
    expect(es.states.at(-1)).toEqual({ status: 'live' });
    expect(conn.diagnostics()).toEqual({
      socketsCreated: 1,
      open: true,
      subscriptions: 2,
      instruments: [ES, NQ],
    });
  });

  test('a subscription added later reuses the open socket and gets the last known status', () => {
    const { conn, sockets } = setup();
    conn.subscribe(NQ, new Recorder());
    const s = sockets[0]!;
    s.open();
    s.serve({ type: 'welcome' });
    s.serve({ type: 'status', market: { status: 'live' } });
    const es = new Recorder();
    conn.subscribe(ES, es);
    expect(sockets).toHaveLength(1);
    expect(s.sent.at(-1)).toEqual({
      type: 'subscribe',
      subId: 's2',
      instrumentId: ES,
      streams: ['market'],
    });
    expect(es.states).toEqual([{ status: 'live' }]);
  });

  test('the same instrument from two charts: two subscriptions, both receive its events', () => {
    const { conn, sockets } = setup();
    const a = new Recorder();
    const b = new Recorder();
    conn.subscribe(NQ, a);
    conn.subscribe(NQ, b);
    const s = sockets[0]!;
    s.open();
    s.serve({ type: 'welcome' });
    s.serve({ type: 'market', events: [bar(NQ)] });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  test('unsubscribing one leaves the other; the last one closes the socket after the idle grace', () => {
    const { conn, sockets } = setup(30_000);
    const nq = new Recorder();
    const sub1 = conn.subscribe(NQ, nq);
    const sub2 = conn.subscribe(ES, new Recorder());
    const s = sockets[0]!;
    s.open();
    s.serve({ type: 'welcome' });
    sub2.unsubscribe();
    expect(s.sent.at(-1)).toEqual({ type: 'unsubscribe', subId: 's2' });
    s.serve({ type: 'market', events: [bar(NQ)] });
    expect(nq.events).toHaveLength(1);
    sub1.unsubscribe();
    advance(29_000);
    expect(s.closedWith).toBeNull();
    // A new chart within the grace period reuses the socket (quick symbol switch).
    conn.subscribe(NQ, new Recorder());
    advance(5_000); // past the original idle deadline (the server is silent, so stay < 30 s)
    expect(s.closedWith).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  test('after the idle close, a new subscription opens a new socket', () => {
    const { conn, sockets } = setup(1_000);
    conn.subscribe(NQ, new Recorder()).unsubscribe();
    sockets[0]!.open();
    advance(1_000);
    expect(sockets[0]!.closedWith).toBe(1000);
    conn.subscribe(ES, new Recorder());
    expect(sockets).toHaveLength(2);
  });
});

describe('recovery', () => {
  test('a seq gap or a hub restart (seq back to 1) triggers a resync for every subscription', () => {
    const { conn, sockets } = setup();
    const nq = new Recorder();
    const es = new Recorder();
    conn.subscribe(NQ, nq);
    conn.subscribe(ES, es);
    const s = sockets[0]!;
    s.open();
    s.serve({ type: 'welcome' });
    s.serve({ type: 'status', market: { status: 'live' } }, 5);
    s.serve({ type: 'resync', scope: 'market', reason: 'server_restart' }, 1);
    expect(nq.resyncs).toEqual(['sequence_gap', 'server_restart', 'server_restart']);
    expect(es.resyncs).toEqual(nq.resyncs);
  });

  test('silence -> reconnect with backoff -> hello + ALL subscriptions -> resync per subscription once re-acknowledged', () => {
    const { conn, sockets } = setup();
    const nq = new Recorder();
    const es = new Recorder();
    conn.subscribe(NQ, nq);
    conn.subscribe(ES, es);
    const s = sockets[0]!;
    s.open();
    s.serve({ type: 'welcome' });
    advance(15_000);
    expect(s.sent.at(-1)).toMatchObject({ type: 'ping' });
    advance(30_000);
    expect(s.closedWith).toBe(4000);
    expect(nq.states.at(-1)).toMatchObject({ status: 'reconnecting', attempt: 1 });
    advance(250);
    expect(sockets).toHaveLength(2);
    const s2 = sockets[1]!;
    s2.open();
    s2.serve({ type: 'welcome' }, 1);
    expect(s2.sent.map((f) => f.type)).toEqual(['hello', 'subscribe', 'subscribe']);
    s2.serve({ type: 'subscribed', subId: 's1', instrumentId: NQ });
    expect(nq.resyncs).toEqual(['reconnected']);
    expect(es.resyncs).toEqual([]);
    s2.serve({ type: 'subscribed', subId: 's2', instrumentId: ES });
    expect(es.resyncs).toEqual(['reconnected']);
  });

  test('backoff grows and is capped; close() stops reconnecting', () => {
    const { conn, sockets } = setup();
    const r = new Recorder();
    conn.subscribe(NQ, r);
    for (let i = 0; i < 12; i++) {
      sockets.at(-1)!.drop();
      advance(60_000);
    }
    const retries = r.states.filter(
      (s): s is Extract<StreamState, { status: 'reconnecting' }> => s.status === 'reconnecting',
    );
    expect(retries.map((s) => s.attempt)).toEqual(retries.map((_, i) => i + 1));
    const count = sockets.length;
    conn.close();
    advance(10 * 60_000);
    expect(sockets.length).toBe(count);
  });
});
