/**
 * Massive futures settings from the Worker environment. Non-secret values come from wrangler.jsonc
 * `vars`; the API key comes from `.dev.vars` locally (gitignored) or a Worker secret later.
 *
 * Fail closed: the REST host and the delayed futures stream URL must be exactly the expected values
 * and the key must be present. Otherwise the futures provider is "not configured" and futures routes
 * answer 503. The reason never includes the key.
 */
export const MASSIVE_PROVIDER_ID = 'massive';
export const MASSIVE_REST_BASE_URL = 'https://api.massive.com';
/** Futures Starter: 10-minute-delayed aggregates (docs/research.md, Massive Starter spike). */
export const MASSIVE_FUTURES_DELAYED_STREAM_URL = 'wss://delayed.massive.com/futures';
/** Observed delay of the Starter feed (REST and WebSocket aggregates, 2026-09-30): ~600 s. */
export const MASSIVE_FUTURES_DELAY_MS = 600_000;
/** Roots Fume supports on this feed (products; contracts are always resolved from reference data). */
export const MASSIVE_FUTURES_ROOTS: readonly string[] = ['ES', 'NQ', 'YM', 'GC', 'SI', 'CL'];

export interface MassiveSettings {
  restBaseUrl: string;
  streamUrl: string;
  apiKey: string;
}

export type MassiveSettingsResult =
  | { ok: true; settings: MassiveSettings }
  | { ok: false; reason: 'missing_credentials' | 'unexpected_host' | 'disabled' };

export function massiveSettingsFromEnv(
  env: Readonly<Record<string, unknown>>,
): MassiveSettingsResult {
  // Production cloud use remains blocked until the operator has written authorization.
  // A key alone never enables it. Local behavior is unchanged unless explicitly disabled.
  if (
    env.FUME_MASSIVE_ENABLED === 'false' ||
    (env.FUME_ENV === 'production' && env.FUME_MASSIVE_ENABLED !== 'true')
  ) {
    return { ok: false, reason: 'disabled' };
  }
  const str = (key: string) => (typeof env[key] === 'string' ? (env[key] as string).trim() : '');
  if (str('MASSIVE_REST_BASE_URL') !== MASSIVE_REST_BASE_URL) {
    return { ok: false, reason: 'unexpected_host' };
  }
  if (str('MASSIVE_FUTURES_STREAM_URL') !== MASSIVE_FUTURES_DELAYED_STREAM_URL) {
    return { ok: false, reason: 'unexpected_host' };
  }
  const apiKey = str('MASSIVE_API_KEY');
  if (!apiKey) return { ok: false, reason: 'missing_credentials' };
  return {
    ok: true,
    settings: {
      restBaseUrl: MASSIVE_REST_BASE_URL,
      streamUrl: MASSIVE_FUTURES_DELAYED_STREAM_URL,
      apiKey,
    },
  };
}
