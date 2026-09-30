/**
 * Alpaca settings from the Worker environment. Non-secret values come from wrangler.jsonc `vars`;
 * the two credentials come from `.dev.vars` locally (gitignored) or Worker secrets later.
 *
 * Fail closed: the data host, the PAPER trading host and the IEX feed must be exactly the expected
 * values, and both credentials must be present. Otherwise the provider is "not configured" and
 * market-data routes answer 503. The reason never includes a credential value.
 */
import type { AlpacaCredentials } from './client.ts';

export const ALPACA_DATA_BASE_URL = 'https://data.alpaca.markets';
export const ALPACA_PAPER_TRADING_BASE_URL = 'https://paper-api.alpaca.markets';
/** Stage 4 feed: IEX (single venue, the Basic plan's real-time entitlement). */
export const ALPACA_FEED = 'iex';

export interface AlpacaSettings {
  dataBaseUrl: string;
  tradingBaseUrl: string;
  feed: typeof ALPACA_FEED;
  credentials: AlpacaCredentials;
}

export type AlpacaSettingsResult =
  | { ok: true; settings: AlpacaSettings }
  | { ok: false; reason: 'missing_credentials' | 'unexpected_host' | 'unexpected_feed' };

export function alpacaSettingsFromEnv(
  env: Readonly<Record<string, unknown>>,
): AlpacaSettingsResult {
  const str = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  if (str('ALPACA_DATA_BASE_URL') !== ALPACA_DATA_BASE_URL)
    return { ok: false, reason: 'unexpected_host' };
  if (str('ALPACA_TRADING_BASE_URL') !== ALPACA_PAPER_TRADING_BASE_URL) {
    return { ok: false, reason: 'unexpected_host' };
  }
  if (str('ALPACA_DATA_FEED') !== ALPACA_FEED) return { ok: false, reason: 'unexpected_feed' };
  const keyId = str('ALPACA_API_KEY_ID');
  const secretKey = str('ALPACA_API_SECRET_KEY');
  if (!keyId || !secretKey) return { ok: false, reason: 'missing_credentials' };
  return {
    ok: true,
    settings: {
      dataBaseUrl: ALPACA_DATA_BASE_URL,
      tradingBaseUrl: ALPACA_PAPER_TRADING_BASE_URL,
      feed: ALPACA_FEED,
      credentials: { keyId, secretKey },
    },
  };
}
