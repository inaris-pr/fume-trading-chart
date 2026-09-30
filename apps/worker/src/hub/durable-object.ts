/**
 * Durable Object host for one FeedHub (one instance per stream key, e.g. one per provider feed;
 * never one global object for all providers). Provider-neutral: the composition root supplies a
 * factory that builds the historical + streaming providers for a key.
 *
 * - Downstream sockets use the WebSocket Hibernation API (`acceptWebSocket`), so they and their
 *   attachments (client subscriptions) survive the object being evicted from memory; a
 *   reconstructed object restores the hub from them.
 * - The stream key is persisted on first use, so a reconstructed object knows which feed it serves.
 * - Only the Worker can reach this object; the key header it trusts is set by the Worker router
 *   after origin and authentication checks.
 */
import type { HistoricalMarketDataProvider, StreamingMarketDataProvider } from '@fume/core';
import { FeedHub, type ClientAttachment, type HubClient } from './feed-hub.ts';
import type { UpstreamConnector } from './upstream.ts';

export const STREAM_KEY_HEADER = 'X-Fume-Stream-Key';
const KEY_STORAGE = 'streamKey';

// Minimal structural types for the workerd APIs used here (no runtime type dependency).
export interface HibernatableSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface DurableObjectStateLike {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: HibernatableSocket): void;
  getWebSockets(): HibernatableSocket[];
}
declare class WebSocketPair {
  0: HibernatableSocket;
  1: HibernatableSocket;
}

export interface HubProviders {
  historical: () => HistoricalMarketDataProvider;
  streaming: StreamingMarketDataProvider;
}

/** Builds the providers for a stream key from the Worker env (null = unknown key/not configured). */
export type HubFactory = (
  key: string,
  env: Readonly<Record<string, unknown>>,
  connect: UpstreamConnector,
) => HubProviders | null;

export class FeedHubDurableObject {
  private readonly state: DurableObjectStateLike;
  private readonly env: Readonly<Record<string, unknown>>;
  private readonly factory: HubFactory;
  private readonly connect: UpstreamConnector;
  private readonly wrappers = new WeakMap<HibernatableSocket, HubClient>();
  private hub: FeedHub | null = null;
  private key: string | null = null;

  constructor(
    state: DurableObjectStateLike,
    env: Readonly<Record<string, unknown>>,
    factory: HubFactory,
    connect: UpstreamConnector,
  ) {
    this.state = state;
    this.env = env;
    this.factory = factory;
    this.connect = connect;
    void state.blockConcurrencyWhile(async () => {
      const key = (await state.storage.get<string>(KEY_STORAGE)) ?? null;
      if (key) await this.ensureHub(key, true);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const key = request.headers.get(STREAM_KEY_HEADER);
    if (!key || (request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (this.key !== null && this.key !== key) {
      return new Response('Wrong hub', { status: 400 });
    }
    const hub = await this.ensureHub(key, false);
    if (!hub) return new Response('Stream not configured', { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    hub.connect(this.wrap(server));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(ws: HibernatableSocket, message: string | ArrayBuffer): Promise<void> {
    const hub = this.hub ?? (this.key ? await this.ensureHub(this.key, true) : null);
    if (!hub) {
      ws.close(1011, 'hub unavailable');
      return;
    }
    if (typeof message !== 'string') return;
    await hub.onMessage(this.wrap(ws), message);
  }

  async webSocketClose(ws: HibernatableSocket, code: number): Promise<void> {
    this.hub?.onClose(this.wrap(ws));
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: HibernatableSocket): Promise<void> {
    this.hub?.onClose(this.wrap(ws));
  }

  // -------------------------------------------------------------------------------------------

  private async ensureHub(key: string, restoring: boolean): Promise<FeedHub | null> {
    if (this.hub) return this.hub;
    const providers = this.factory(key, this.env, this.connect);
    if (!providers) return null;
    if (this.key === null) {
      this.key = key;
      await this.state.storage.put(KEY_STORAGE, key);
    }
    const hub = new FeedHub({
      feedKey: key,
      historical: providers.historical,
      streaming: providers.streaming,
      storage: this.state.storage,
      log: (entry) => console.log(JSON.stringify(entry)),
    });
    this.hub = hub;
    await hub.restore(restoring ? this.state.getWebSockets().map((ws) => this.wrap(ws)) : []);
    return hub;
  }

  private wrap(ws: HibernatableSocket): HubClient {
    let client = this.wrappers.get(ws);
    if (!client) {
      client = {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        getAttachment: () => (ws.deserializeAttachment() as ClientAttachment | null) ?? null,
        setAttachment: (a) => ws.serializeAttachment(a),
      };
      this.wrappers.set(ws, client);
    }
    return client;
  }
}
