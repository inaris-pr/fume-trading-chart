/**
 * FeedHub (provider-neutral stream hub) and its Durable Object host, with the REAL Massive stream
 * adapter and REST adapter wired to offline fakes (scripted socket + FakeMassive). Covers the
 * subscription union, fan-out, idle grace, REST reconciliation after reconnect, the connection
 * conflict hold, multiple clients on one upstream, and reconstruction from socket attachments.
 */
import { describe, expect, test } from 'vitest';
import type { InstrumentId, MarketEvent } from '@fume/core';
import {
  FeedHubDurableObject,
  STREAM_KEY_HEADER,
  type HibernatableSocket,
} from '../src/hub/durable-object.ts';
import { FeedHub, type ClientAttachment, type HubClient } from '../src/hub/feed-hub.ts';
import { MassiveHttpClient } from '../src/providers/massive/client.ts';
import {
  MassiveFuturesMarketDataProvider,
  MassiveSharedCache,
} from '../src/providers/massive/market-data-provider.ts';
import { MassiveFuturesStreamProvider } from '../src/providers/massive/stream.ts';
import { FakeMassive, TEST_MASSIVE_KEY } from './fake-massive.ts';
import {
  FakeMassiveSocketServer,
  flush,
  ManualClock,
  wsMinute,
  wsSecond,
} from './fake-upstream.ts';

const NOW = Date.UTC(2026, 8, 30, 17, 40);
const NQ = 'fut:NQ:2026-12';
const GC = 'fut:GC:2026-12';
const MIN = 60_000;

class MemoryStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

class FakeClient implements HubClient {
  readonly frames: Record<string, any>[] = [];
  attachment: ClientAttachment | null = null;
  closed: number | null = null;
  send(text: string): void {
    this.frames.push(JSON.parse(text));
  }
  close(code: number): void {
    this.closed = code;
  }
  getAttachment(): ClientAttachment | null {
    return this.attachment ? structuredClone(this.attachment) : null;
  }
  setAttachment(a: ClientAttachment): void {
    this.attachment = structuredClone(a);
  }
  of(type: string) {
    return this.frames.filter((f) => f.type === type);
  }
  marketEvents(): MarketEvent[] {
    return this.of('market').flatMap((f) => f.events as MarketEvent[]);
  }
}

function world(storage = new MemoryStorage()) {
  const clock = new ManualClock(NOW);
  const rest = new FakeMassive({ now: NOW });
  const cache = new MassiveSharedCache();
  const historical = () =>
    new MassiveFuturesMarketDataProvider({
      client: new MassiveHttpClient({
        baseUrl: 'https://api.massive.com',
        apiKey: TEST_MASSIVE_KEY,
        fetch: rest.fetch,
        maxCalls: 20,
      }),
      cache,
      now: () => clock.now,
    });
  const server = new FakeMassiveSocketServer(TEST_MASSIVE_KEY);
  const streaming = new MassiveFuturesStreamProvider({
    url: 'wss://delayed.massive.com/futures',
    apiKey: TEST_MASSIVE_KEY,
    feed: historical().feed,
    connect: server.connect,
    now: () => clock.now,
    timers: clock.timers,
    random: () => 0.5,
  });
  const hub = new FeedHub({
    feedKey: 'futures-delayed',
    historical,
    streaming,
    storage,
    now: () => clock.now,
    timers: clock.timers,
    newId: (() => {
      let n = 0;
      return () => `c${++n}`;
    })(),
  });
  return { clock, rest, server, hub, storage, historical, streaming };
}

async function join(hub: FeedHub, ...subs: [string, string][]) {
  const client = new FakeClient();
  hub.connect(client);
  await hub.onMessage(client, JSON.stringify({ type: 'hello', protocol: 1 }));
  for (const [subId, instrumentId] of subs) {
    await hub.onMessage(
      client,
      JSON.stringify({ type: 'subscribe', subId, instrumentId, streams: ['market'] }),
    );
  }
  await flush();
  return client;
}

const subscribeParams = (server: FakeMassiveSocketServer) =>
  server.connections
    .flatMap((c) => c.sent as { action: string; params: string }[])
    .filter((f) => f.action !== 'auth');

describe('protocol', () => {
  test('hello -> welcome (feed metadata, no provider internals) + status; ping -> pong; seq +1 per frame', async () => {
    const { hub } = world();
    const client = await join(hub);
    await hub.onMessage(client, JSON.stringify({ type: 'ping', t: 42 }));
    expect(client.frames.map((f) => f.type)).toEqual(['welcome', 'status', 'pong']);
    expect(client.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(client.frames[0]).toMatchObject({
      protocol: 1,
      connectionId: 'c1',
      feed: { feedId: 'futures-delayed', delayMs: 600_000 },
      tradingEnvironment: 'paper',
    });
    expect(JSON.stringify(client.frames)).not.toContain(TEST_MASSIVE_KEY);
  });

  test('frames before hello, malformed frames, unknown instruments and bad protocol versions are refused', async () => {
    const { hub } = world();
    const client = new FakeClient();
    hub.connect(client);
    await hub.onMessage(
      client,
      JSON.stringify({ type: 'subscribe', subId: 'a', instrumentId: NQ, streams: ['market'] }),
    );
    await hub.onMessage(client, '{not json');
    await hub.onMessage(client, JSON.stringify({ type: 'hello', protocol: 1 }));
    await hub.onMessage(
      client,
      JSON.stringify({
        type: 'subscribe',
        subId: 'b',
        instrumentId: 'eq:SPY',
        streams: ['market'],
      }),
    );
    await hub.onMessage(
      client,
      JSON.stringify({
        type: 'subscribe',
        subId: 'c',
        instrumentId: 'fut:ZB:2026-12',
        streams: ['market'],
      }),
    );
    expect(client.of('error').map((f) => f.code)).toEqual([
      'invalid_request',
      'invalid_request',
      'not_found',
      'not_found',
    ]);
    const old = new FakeClient();
    hub.connect(old);
    await hub.onMessage(old, JSON.stringify({ type: 'hello', protocol: 2 }));
    expect(old.closed).toBe(1002);
    expect(hub.diagnostics().instruments).toEqual([]);
  });
});

describe('one upstream, subscription union, fan-out', () => {
  test('two clients on different contracts share ONE upstream with the union of subscriptions', async () => {
    const { hub, server } = world();
    const a = await join(hub, ['s1', NQ]);
    const b = await join(hub, ['s1', GC]);
    expect(server.connections).toHaveLength(1);
    expect(subscribeParams(server)).toEqual([
      { action: 'subscribe', params: 'A.NQZ6,AM.NQZ6' },
      { action: 'subscribe', params: 'A.GCZ6,AM.GCZ6' },
    ]);
    expect(a.of('subscribed')).toEqual([
      expect.objectContaining({ subId: 's1', instrumentId: NQ }),
    ]);
    // Each client receives only its own instrument.
    a.frames.length = 0;
    b.frames.length = 0;
    const s = Date.UTC(2026, 8, 30, 17, 30, 1);
    server.connections[0]!.push(
      wsSecond('NQZ6', s, 1, 2, 1, 2, 3),
      wsSecond('GCZ6', s, 4, 4, 4, 4, 1),
    );
    expect(a.marketEvents().map((e) => (e.kind === 'bar' ? e.instrumentId : ''))).toEqual([NQ]);
    expect(b.marketEvents().map((e) => (e.kind === 'bar' ? e.instrumentId : ''))).toEqual([GC]);
  });

  test('the same contract from two clients is subscribed upstream once; leaving updates the union', async () => {
    const { hub, server } = world();
    const a = await join(hub, ['s1', NQ]);
    const b = await join(hub, ['x', NQ], ['y', GC]);
    expect(subscribeParams(server)).toEqual([
      { action: 'subscribe', params: 'A.NQZ6,AM.NQZ6' },
      { action: 'subscribe', params: 'A.GCZ6,AM.GCZ6' },
    ]);
    hub.onClose(b);
    await flush();
    expect(subscribeParams(server).at(-1)).toEqual({
      action: 'unsubscribe',
      params: 'A.GCZ6,AM.GCZ6',
    });
    expect(hub.diagnostics()).toMatchObject({ clients: 1, instruments: [NQ] });
    await hub.onMessage(a, JSON.stringify({ type: 'unsubscribe', subId: 's1' }));
    await flush();
    expect(subscribeParams(server).at(-1)).toEqual({
      action: 'unsubscribe',
      params: 'A.NQZ6,AM.NQZ6',
    });
  });

  test('last subscription gone -> upstream closes only after the ~60 s idle grace', async () => {
    const { hub, server, clock } = world();
    const a = await join(hub, ['s1', NQ]);
    hub.onClose(a);
    await clock.advance(59_000);
    expect(server.open).toHaveLength(1);
    // A client returning within the grace period reuses the same upstream.
    const b = await join(hub, ['s1', NQ]);
    await clock.advance(120_000);
    expect(server.connections).toHaveLength(1);
    hub.onClose(b);
    await clock.advance(60_000);
    expect(server.open).toHaveLength(0);
    expect(hub.diagnostics().upstreamOpen).toBe(false);
  });

  test('per-client subscription limit', async () => {
    const { hub } = world();
    const client = await join(hub);
    for (let i = 0; i < 11; i++) {
      await hub.onMessage(
        client,
        JSON.stringify({
          type: 'subscribe',
          subId: `s${i}`,
          instrumentId: NQ,
          streams: ['market'],
        }),
      );
    }
    expect(client.of('error').map((f) => f.code)).toEqual(['symbol_limit']);
  });
});

describe('recovery', () => {
  test('after an upstream reconnect the hub sends recent COMPLETED minutes from REST as authoritative 1m bars', async () => {
    const { hub, server, clock } = world();
    const a = await join(hub, ['s1', NQ]);
    const firstReconcile = a.marketEvents().length; // initial live transition also reconciles
    expect(firstReconcile).toBeGreaterThan(0);
    a.frames.length = 0;
    server.connections[0]!.drop(1006);
    await clock.advance(1_000);
    await flush();
    await flush();
    expect(server.connections).toHaveLength(2);
    const bars = a.marketEvents().filter((e) => e.kind === 'bar');
    expect(bars.length).toBeGreaterThan(20);
    expect(bars.every((e) => e.kind === 'bar' && e.interval === '1m' && e.phase === 'final')).toBe(
      true,
    );
    // Only minutes complete in DELAYED time (now - 10 min), never the forming minute.
    const delayedNow = clock.now - 10 * MIN;
    const last = bars.at(-1)!;
    expect(last.kind === 'bar' && last.bar.start + MIN).toBeLessThanOrEqual(delayedNow);
    expect(a.of('status').map((f) => f.market.status)).toEqual([
      'reconnecting',
      'connecting',
      'authenticating',
      'live',
    ]);
  });

  test('REST reconciliation failure -> subscribers are told to re-fetch the tail themselves', async () => {
    const { hub, rest, server, clock } = world();
    const a = await join(hub, ['s1', NQ]);
    (rest as unknown as { options: { failPaths: Record<string, number> } }).options.failPaths = {
      '/futures/v1/aggs/': 503,
    };
    a.frames.length = 0;
    server.connections[0]!.drop(1006);
    await clock.advance(1_000);
    await flush();
    await flush();
    expect(a.of('resync')).toEqual([
      expect.objectContaining({ scope: 'market', reason: 'reconcile_failed' }),
    ]);
    expect(hub.diagnostics().reconcileFailures).toBe(1);
  });

  test('max_connections: conflict surfaced to clients (no provider internals), hold persisted, no fight', async () => {
    const storage = new MemoryStorage();
    const { hub, server, clock } = world(storage);
    const a = await join(hub, ['s1', NQ]);
    server.displaceOldest();
    await flush();
    const status = a.of('status').at(-1)!;
    expect(status.market).toEqual({
      status: 'reconnecting',
      attempt: 1,
      nextRetryAt: NOW + 60_000,
      lastError: {
        code: 'unavailable',
        message: 'The feed connection was taken over by another connection',
        retryable: true,
        reason: 'connection_conflict',
      },
    });
    expect(JSON.stringify(status)).not.toContain('max_connections');
    expect(storage.data.get('upstreamHoldUntil')).toBe(NOW + 60_000);
    await clock.advance(30_000);
    expect(server.connections).toHaveLength(1);
    await clock.advance(31_000);
    await flush();
    expect(server.connections).toHaveLength(2);
    expect(storage.data.get('upstreamHoldUntil')).toBe(0); // cleared once live again
  });
});

describe('reconstruction (in-memory state is disposable)', () => {
  test('a new hub restores clients + union from socket attachments and resubscribes upstream', async () => {
    const storage = new MemoryStorage();
    const first = world(storage);
    const a = await join(first.hub, ['s1', NQ]);
    const b = await join(first.hub, ['s1', GC]);
    // The object is evicted: a new hub (new upstream server) is built from the same sockets.
    const second = world(storage);
    a.frames.length = 0;
    await second.hub.restore([a, b]);
    await flush();
    expect(second.server.connections).toHaveLength(1);
    expect(subscribeParams(second.server)).toEqual([
      { action: 'subscribe', params: 'A.NQZ6,AM.NQZ6,A.GCZ6,AM.GCZ6' },
    ]);
    expect(a.of('resync')).toEqual([expect.objectContaining({ reason: 'server_restart' })]);
    expect(a.frames[0]!.seq).toBe(1); // restarted seq -> the client also detects the restart
    const s = Date.UTC(2026, 8, 30, 17, 30, 1);
    second.server.connections[0]!.push(wsMinute('GCZ6', s - 1000, 1, 1, 1, 1, 1));
    expect(b.marketEvents().some((e) => e.kind === 'bar' && e.instrumentId === GC)).toBe(true);
  });

  test('a persisted conflict hold survives reconstruction (the new hub waits instead of fighting)', async () => {
    const storage = new MemoryStorage();
    await storage.put('upstreamHoldUntil', NOW + 5 * MIN);
    const { hub, server, clock } = world(storage);
    const a = new FakeClient();
    a.attachment = { v: 1, clientId: 'c9', greeted: true, subs: { s1: NQ } };
    await hub.restore([a]);
    await flush();
    expect(server.connections).toHaveLength(0);
    await clock.advance(5 * MIN);
    expect(server.connections).toHaveLength(1);
  });
});

describe('Durable Object host', () => {
  class FakeSocket implements HibernatableSocket {
    sent: string[] = [];
    attachment: unknown = null;
    closed: number | null = null;
    send(m: string) {
      this.sent.push(m);
    }
    close(code?: number) {
      this.closed = code ?? 1000;
    }
    serializeAttachment(v: unknown) {
      this.attachment = structuredClone(v);
    }
    deserializeAttachment() {
      return this.attachment;
    }
  }

  function fakeState(storage: MemoryStorage, sockets: FakeSocket[]) {
    return {
      storage,
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
      acceptWebSocket: (ws: HibernatableSocket) => void sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
    };
  }

  test('rebuilds the hub for its persisted stream key from hibernated sockets after eviction', async () => {
    const storage = new MemoryStorage();
    const { historical, streaming, server } = world(storage);
    const sockets: FakeSocket[] = [];
    // First incarnation: learn the key via fetch is not possible without WebSocketPair in Node,
    // so simulate a socket accepted earlier (attachment with a subscription) and a stored key.
    await storage.put('streamKey', 'futures-delayed');
    const ws = new FakeSocket();
    ws.attachment = {
      v: 1,
      clientId: 'c1',
      greeted: true,
      subs: { s1: NQ },
    } satisfies ClientAttachment;
    sockets.push(ws);
    let built = 0;
    const host = new FeedHubDurableObject(
      fakeState(storage, sockets) as never,
      {},
      (key) => {
        built++;
        return key === 'futures-delayed' ? { historical, streaming } : null;
      },
      server.connect,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    expect(built).toBe(1);
    expect(subscribeParams(server)).toEqual([{ action: 'subscribe', params: 'A.NQZ6,AM.NQZ6' }]);
    await host.webSocketMessage(ws, JSON.stringify({ type: 'ping', t: 1 }));
    expect(ws.sent.map((t) => JSON.parse(t).type)).toContain('pong');
    // Requests without the Worker-set key header or without an upgrade are refused.
    const plain = await host.fetch(
      new Request('http://hub/', { headers: { [STREAM_KEY_HEADER]: 'futures-delayed' } }),
    );
    expect(plain.status).toBe(426);
    await host.webSocketClose(ws, 1006);
    expect(ws.closed).toBe(1000);
  });
});
