/**
 * Worker composition root: the ONLY module that imports provider adapters. It registers one
 * market-data feed per asset class (US equities/ETFs -> Alpaca IEX, futures -> Massive delayed),
 * wires the provider-neutral router to that registry, and binds the provider/feed-scoped stream
 * hubs (one Durable Object instance per stream key).
 */
import { serveFrontend } from './assets.ts';
import { parseAllowedOrigins } from './cors.ts';
import type { FumeEnv } from './env.ts';
import {
  FeedHubDurableObject,
  STREAM_KEY_HEADER,
  type DurableObjectStateLike,
  type HubFactory,
} from './hub/durable-object.ts';
import { workerdConnector } from './hub/upstream.ts';
import { AlpacaHttpClient } from './providers/alpaca/client.ts';
import { alpacaSettingsFromEnv } from './providers/alpaca/config.ts';
import {
  ALPACA_HISTORY_FLOOR,
  AlpacaMarketDataProvider,
  AlpacaSharedCache,
} from './providers/alpaca/market-data-provider.ts';
import { MassiveHttpClient } from './providers/massive/client.ts';
import { massiveSettingsFromEnv, MASSIVE_PROVIDER_ID } from './providers/massive/config.ts';
import {
  massiveHistoryFloor,
  MassiveFuturesMarketDataProvider,
  MassiveSharedCache,
} from './providers/massive/market-data-provider.ts';
import { MassiveFuturesStreamProvider } from './providers/massive/stream.ts';
import { MarketDataRegistry } from './registry.ts';
import { handleRequest, type StreamForwarder } from './router.ts';

/** Isolate-level caches (calendars, reference data). Never hold credentials. */
const alpacaCache = new AlpacaSharedCache();
const massiveCache = new MassiveSharedCache();

/** Opaque stream-hub key of the delayed futures feed (the browser never sees a provider name). */
const FUTURES_STREAM_KEY = 'futures-delayed';

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

function massiveFutures(env: Readonly<Record<string, unknown>>, maxCalls: number) {
  const settings = massiveSettingsFromEnv(env);
  if (!settings.ok) return { settings, client: null, provider: null } as const;
  const client = new MassiveHttpClient({
    baseUrl: settings.settings.restBaseUrl,
    apiKey: settings.settings.apiKey,
    fetch: (input, init) => fetch(input, init),
    maxCalls,
  });
  const provider = new MassiveFuturesMarketDataProvider({ client, cache: massiveCache });
  return { settings, client, provider } as const;
}

export default {
  async fetch(request: Request, env: FumeEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return serveFrontend(request, env);
    const alpaca = alpacaSettingsFromEnv(env);
    const alpacaClient = alpaca.ok
      ? new AlpacaHttpClient({
          dataBaseUrl: alpaca.settings.dataBaseUrl,
          tradingBaseUrl: alpaca.settings.tradingBaseUrl,
          credentials: alpaca.settings.credentials,
          fetch: (input, init) => fetch(input, init),
          maxCalls: 16,
        })
      : null;
    const equities = alpacaClient
      ? new AlpacaMarketDataProvider({ client: alpacaClient, cache: alpacaCache })
      : null;
    const futures = massiveFutures(env, 16);
    const hubs = env.FEED_HUB as DurableObjectNamespaceLike | undefined;
    const stream: StreamForwarder | null = hubs
      ? (key, req) => {
          // The hub needs no browser cookies or Access assertion after authentication.
          const headers = new Headers({ Upgrade: 'websocket' });
          headers.set(STREAM_KEY_HEADER, key);
          return hubs.get(hubs.idFromName(key)).fetch(new Request(req, { headers }));
        }
      : null;

    const registry = new MarketDataRegistry([
      {
        providerId: 'alpaca',
        provider: equities,
        feed: equities?.feed ?? {
          providerId: 'alpaca',
          feedId: 'iex',
          consolidated: false,
          delayMs: 0,
        },
        assetClasses: ['equity', 'etf'],
        idNamespace: 'eq',
        historyFloor: () => ALPACA_HISTORY_FLOOR,
        // Alpaca streaming is not part of this build: equities are history only.
        streamKey: null,
      },
      {
        providerId: MASSIVE_PROVIDER_ID,
        provider: futures.provider,
        feed: futures.provider?.feed ?? {
          providerId: MASSIVE_PROVIDER_ID,
          feedId: 'futures-delayed',
          consolidated: true,
          delayMs: 600_000,
        },
        assetClasses: ['future'],
        idNamespace: 'fut',
        historyFloor: () => massiveHistoryFloor(Date.now()),
        streamKey: FUTURES_STREAM_KEY,
      },
    ]);

    return handleRequest(request, {
      fumeEnv: env.FUME_ENV,
      access: { teamDomain: env.FUME_ACCESS_TEAM_DOMAIN, audience: env.FUME_ACCESS_AUD },
      allowedOrigins: parseAllowedOrigins(env.FUME_ALLOWED_ORIGINS),
      registry,
      stream,
      now: Date.now,
      providerCalls: () => (alpacaClient?.calls ?? 0) + (futures.client?.calls ?? 0),
      log: (entry) =>
        console.log(
          JSON.stringify({
            ...entry,
            ...(alpaca.ok ? {} : { marketData: `not_configured:${alpaca.reason}` }),
            ...(futures.settings.ok
              ? {}
              : { futuresData: `not_configured:${futures.settings.reason}` }),
          }),
        ),
    });
  },
};

/** Builds the providers of one stream hub. Only the futures feed streams in this build. */
const hubFactory: HubFactory = (key, env, connect) => {
  if (key !== FUTURES_STREAM_KEY) return null;
  const settings = massiveSettingsFromEnv(env);
  if (!settings.ok) return null;
  const historical = () => {
    const client = new MassiveHttpClient({
      baseUrl: settings.settings.restBaseUrl,
      apiKey: settings.settings.apiKey,
      fetch: (input, init) => fetch(input, init),
      maxCalls: 8,
    });
    return new MassiveFuturesMarketDataProvider({ client, cache: massiveCache });
  };
  return {
    historical,
    streaming: new MassiveFuturesStreamProvider({
      url: settings.settings.streamUrl,
      apiKey: settings.settings.apiKey,
      feed: historical().feed,
      connect,
      log: (entry) => console.log(JSON.stringify(entry)),
    }),
  };
};

/** One instance per stream key (provider/feed-scoped hub). */
export class FeedHubObject extends FeedHubDurableObject {
  constructor(state: DurableObjectStateLike, env: Readonly<Record<string, unknown>>) {
    super(state, env, hubFactory, workerdConnector);
  }
}
