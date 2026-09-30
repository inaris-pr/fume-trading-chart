/**
 * Massive delayed stream adapter against a scripted fake socket: handshake, declarative
 * subscriptions, A/AM normalization (numeric strings), reconnect with bounded backoff, and the
 * single-connection conflict (max_connections / 1008). No network, no live data.
 */
import { describe, expect, test } from 'vitest';
import type { InstrumentId, MarketEvent, MarketSubscription } from '@fume/core';
import { MassiveFuturesStreamProvider } from '../src/providers/massive/stream.ts';
import {
  FakeMassiveSocketServer,
  flush,
  ManualClock,
  wsMinute,
  wsSecond,
} from './fake-upstream.ts';

const KEY = 'test-massive-key-not-real-0000';
const T0 = Date.UTC(2026, 8, 30, 17, 40);
const NQ = 'fut:NQ:2026-12' as InstrumentId;
const GC = 'fut:GC:2026-12' as InstrumentId;
const FEED = {
  providerId: 'massive',
  feedId: 'futures-delayed',
  consolidated: true,
  delayMs: 600_000,
};

const sub = (instrumentId: InstrumentId, symbol: string): MarketSubscription => ({
  instrumentId,
  channels: ['secondBars', 'minuteBars'],
  marketDataRef: { providerId: 'massive', symbol },
});

async function start(
  options: ConstructorParameters<typeof FakeMassiveSocketServer>[1] = {},
  notBefore?: number,
) {
  const clock = new ManualClock(T0);
  const server = new FakeMassiveSocketServer(KEY, options);
  const events: MarketEvent[] = [];
  const provider = new MassiveFuturesStreamProvider({
    url: 'wss://delayed.massive.com/futures',
    apiKey: KEY,
    feed: FEED,
    connect: server.connect,
    now: () => clock.now,
    timers: clock.timers,
    random: () => 0.5,
  });
  const stream = provider.openStream(
    { onEvents: (e) => events.push(...e) },
    notBefore !== undefined ? { notBefore } : {},
  );
  await flush();
  return { clock, server, events, stream, provider };
}

const statuses = (events: readonly MarketEvent[]) =>
  events
    .filter((e) => e.kind === 'stream_status')
    .map((e) => (e.kind === 'stream_status' ? e.state.status : ''));

describe('handshake and subscriptions', () => {
  test('connect -> auth (key only in the auth frame) -> live -> subscribe A + AM for each contract', async () => {
    const { server, events, stream } = await start();
    stream.setSubscriptions([sub(NQ, 'NQZ6'), sub(GC, 'GCZ6')]);
    await flush();
    const conn = server.connections[0]!;
    expect(conn.url).toBe('wss://delayed.massive.com/futures');
    expect(conn.sent).toEqual([
      { action: 'auth', params: KEY },
      { action: 'subscribe', params: 'A.NQZ6,AM.NQZ6,A.GCZ6,AM.GCZ6' },
    ]);
    expect(statuses(events)).toEqual(['connecting', 'authenticating', 'live']);
    // No event ever carries the key.
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  test('subscriptions are declarative: only the diff is sent; all six fit on one connection', async () => {
    const { server, stream } = await start();
    const six = [
      sub(NQ, 'NQZ6'),
      sub(GC, 'GCZ6'),
      sub('fut:SI:2026-12' as InstrumentId, 'SIZ6'),
      sub('fut:CL:2026-11' as InstrumentId, 'CLX6'),
      sub('fut:YM:2026-12' as InstrumentId, 'YMZ6'),
      sub('fut:ES:2026-12' as InstrumentId, 'ESZ6'),
    ];
    stream.setSubscriptions(six.slice(0, 1));
    await flush();
    stream.setSubscriptions(six);
    stream.setSubscriptions(six.slice(1));
    await flush();
    const conn = server.connections[0]!;
    expect(server.connections).toHaveLength(1);
    expect(conn.sent.slice(1)).toEqual([
      { action: 'subscribe', params: 'A.NQZ6,AM.NQZ6' },
      {
        action: 'subscribe',
        params: 'A.GCZ6,AM.GCZ6,A.SIZ6,AM.SIZ6,A.CLX6,AM.CLX6,A.YMZ6,AM.YMZ6,A.ESZ6,AM.ESZ6',
      },
      { action: 'unsubscribe', params: 'A.NQZ6,AM.NQZ6' },
    ]);
  });

  test('subscriptions for another provider or without aggregate channels are ignored', async () => {
    const { server, stream } = await start();
    stream.setSubscriptions([
      {
        instrumentId: NQ,
        channels: ['trades'],
        marketDataRef: { providerId: 'massive', symbol: 'NQZ6' },
      },
      {
        instrumentId: 'eq:SPY' as InstrumentId,
        channels: ['secondBars'],
        marketDataRef: { providerId: 'other', symbol: 'SPY' },
      },
    ]);
    await flush();
    expect(server.connections[0]!.sent).toEqual([{ action: 'auth', params: KEY }]);
  });
});

describe('normalized aggregate events', () => {
  test('A -> 1s provisional bar, AM -> 1m final bar; string prices become numbers', async () => {
    const { server, events, stream } = await start();
    stream.setSubscriptions([sub(NQ, 'NQZ6')]);
    await flush();
    const s = Date.UTC(2026, 8, 30, 17, 30, 4);
    const m = Date.UTC(2026, 8, 30, 17, 30);
    server.connections[0]!.push(
      wsSecond('NQZ6', s, 30790, 30790.25, 30788.75, 30789, 15),
      wsMinute('NQZ6', m, 30789, 30797.75, 30788.25, 30796, 653),
    );
    const bars = events.filter((e) => e.kind === 'bar');
    expect(bars).toEqual([
      {
        kind: 'bar',
        instrumentId: NQ,
        interval: '1s',
        phase: 'provisional',
        bar: {
          start: s,
          open: 30790,
          high: 30790.25,
          low: 30788.75,
          close: 30789,
          volume: 15,
          tradeCount: 1,
          status: 'provisional',
          revision: 0,
        },
      },
      {
        kind: 'bar',
        instrumentId: NQ,
        interval: '1m',
        phase: 'final',
        bar: {
          start: m,
          open: 30789,
          high: 30797.75,
          low: 30788.25,
          close: 30796,
          volume: 653,
          tradeCount: 3,
          status: 'final',
          revision: 0,
        },
      },
    ]);
  });

  test('malformed or unknown-symbol aggregates are dropped and counted, never forwarded', async () => {
    const { server, events, stream } = await start();
    stream.setSubscriptions([sub(NQ, 'NQZ6')]);
    await flush();
    const s = Date.UTC(2026, 8, 30, 17, 30, 4);
    server.connections[0]!.push(
      { ...wsSecond('NQZ6', s, 1, 1, 1, 1, 1), e: s + 2000 }, // wrong width
      { ...wsSecond('NQZ6', s, 1, 1, 1, 1, 1), o: 'abc' },
      { ...wsSecond('NQZ6', s, 1, 2, 1, 3, 1) }, // close above high
      wsSecond('ESZ6', s, 1, 1, 1, 1, 1),
    );
    expect(events.filter((e) => e.kind === 'bar')).toEqual([]);
    expect(stream.diagnostics()).toMatchObject({ malformed: 3, unknownSymbols: 1 });
  });
});

describe('reconnect and conflicts', () => {
  test('an unexpected disconnect reconnects with bounded backoff, resubscribes and signals resync', async () => {
    const { server, events, stream, clock } = await start();
    stream.setSubscriptions([sub(NQ, 'NQZ6')]);
    await flush();
    server.connections[0]!.drop(1006);
    await flush();
    const reconnecting = events.find(
      (e) => e.kind === 'stream_status' && e.state.status === 'reconnecting',
    );
    expect(reconnecting).toMatchObject({
      state: { attempt: 1, lastError: { reason: 'upstream_disconnected', retryable: true } },
    });
    expect(server.connections).toHaveLength(1);
    await clock.advance(1_000); // backoff: 1 s x jitter 0.5 = 500 ms (min 250 ms)
    expect(server.connections).toHaveLength(2);
    expect(server.connections[1]!.sent).toEqual([
      { action: 'auth', params: KEY },
      { action: 'subscribe', params: 'A.NQZ6,AM.NQZ6' },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'resync_required', reason: 'stream_reconnected' });
  });

  test('backoff grows and is capped at 30 s while the feed stays unreachable', async () => {
    const { server, stream, clock, events } = await start();
    stream.setSubscriptions([sub(NQ, 'NQZ6')]);
    await flush();
    server.options.refuse = true;
    server.connections[0]!.drop(1006);
    await clock.advance(6 * 60_000);
    const retryAts = events
      .filter((e) => e.kind === 'stream_status' && e.state.status === 'reconnecting')
      .map((e) =>
        e.kind === 'stream_status' && e.state.status === 'reconnecting' ? e.state.nextRetryAt : 0,
      );
    const gaps = retryAts.slice(1).map((t, i) => t - retryAts[i]!);
    // Each failed attempt waits at least as long as the previous one, never more than 30 s.
    expect(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]!)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
    expect(gaps.at(-1)).toBe(15_000); // 30 s cap x jitter 0.5
    expect(stream.diagnostics().connects).toBeLessThan(35); // ~6 min: no tight loop
    expect(clock.pending()).toBe(1);
  });

  test('max_connections: conflict reason, long bounded backoff, no reconnect fight', async () => {
    const { server, events, stream, clock } = await start();
    stream.setSubscriptions([sub(NQ, 'NQZ6')]);
    await flush();
    server.displaceOldest();
    await flush();
    const state = events.filter((e) => e.kind === 'stream_status').at(-1);
    expect(state).toMatchObject({
      state: {
        status: 'reconnecting',
        attempt: 1,
        nextRetryAt: T0 + 60_000,
        lastError: { reason: 'connection_conflict', code: 'unavailable' },
      },
    });
    await clock.advance(59_000);
    expect(server.connections).toHaveLength(1); // still waiting: no fight
    await clock.advance(1_000);
    expect(server.connections).toHaveLength(2);
    // A second displacement doubles the hold (capped at 15 min).
    server.displaceOldest();
    await flush();
    const second = events.filter((e) => e.kind === 'stream_status').at(-1);
    expect(second).toMatchObject({ state: { attempt: 2, nextRetryAt: clock.now + 120_000 } });
    expect(stream.diagnostics().conflicts).toBe(2);
  });

  test('close code 1008 alone is also treated as a conflict', async () => {
    const { server, events } = await start();
    await flush();
    server.connections[0]!.drop(1008);
    await flush();
    expect(events.filter((e) => e.kind === 'stream_status').at(-1)).toMatchObject({
      state: { lastError: { reason: 'connection_conflict' } },
    });
  });

  test('a persisted hold (notBefore) delays the first connection', async () => {
    const { server, clock, events } = await start({}, T0 + 90_000);
    expect(server.connections).toHaveLength(0);
    expect(events[0]).toMatchObject({
      state: { status: 'reconnecting', nextRetryAt: T0 + 90_000 },
    });
    await clock.advance(90_000);
    expect(server.connections).toHaveLength(1);
  });

  test('rejected credentials: auth_failed reason and a long backoff', async () => {
    const { server, events, clock } = await start({ rejectAuth: true });
    await flush();
    expect(events.filter((e) => e.kind === 'stream_status').at(-1)).toMatchObject({
      state: {
        status: 'reconnecting',
        nextRetryAt: T0 + 5 * 60_000,
        lastError: { reason: 'auth_failed' },
      },
    });
    await clock.advance(4 * 60_000);
    expect(server.connections).toHaveLength(1);
  });

  test('close() stops everything: no reconnect, final closed state', async () => {
    const { server, events, stream, clock } = await start();
    await flush();
    stream.close();
    await clock.advance(10 * 60_000);
    expect(server.connections).toHaveLength(1);
    expect(server.connections[0]!.closed).toMatchObject({ code: 1000 });
    expect(statuses(events).at(-1)).toBe('closed');
  });
});
