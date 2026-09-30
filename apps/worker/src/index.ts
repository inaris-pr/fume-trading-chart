/**
 * Worker composition root: the ONLY module that imports a provider adapter. It wires the
 * provider-neutral router to the Alpaca historical adapter for each request.
 */
import { parseAllowedOrigins } from './cors.ts';
import type { FumeEnv } from './env.ts';
import { AlpacaHttpClient } from './providers/alpaca/client.ts';
import { alpacaSettingsFromEnv } from './providers/alpaca/config.ts';
import {
  ALPACA_HISTORY_FLOOR,
  AlpacaMarketDataProvider,
  AlpacaSharedCache,
} from './providers/alpaca/market-data-provider.ts';
import { handleRequest } from './router.ts';

/** Isolate-level caches (calendar years, asset lookups). Never holds credentials. */
const alpacaCache = new AlpacaSharedCache();

export default {
  async fetch(request: Request, env: FumeEnv): Promise<Response> {
    const alpaca = alpacaSettingsFromEnv(env);
    const client = alpaca.ok
      ? new AlpacaHttpClient({
          dataBaseUrl: alpaca.settings.dataBaseUrl,
          tradingBaseUrl: alpaca.settings.tradingBaseUrl,
          credentials: alpaca.settings.credentials,
          fetch: (input, init) => fetch(input, init),
          maxCalls: 16,
        })
      : null;
    const provider = client ? new AlpacaMarketDataProvider({ client, cache: alpacaCache }) : null;
    return handleRequest(request, {
      fumeEnv: env.FUME_ENV,
      allowedOrigins: parseAllowedOrigins(env.FUME_ALLOWED_ORIGINS),
      provider,
      historyFloor: ALPACA_HISTORY_FLOOR,
      now: Date.now,
      providerCalls: () => client?.calls ?? 0,
      log: (entry) =>
        console.log(
          JSON.stringify({
            ...entry,
            ...(alpaca.ok ? {} : { marketData: `not_configured:${alpaca.reason}` }),
          }),
        ),
    });
  },
};
