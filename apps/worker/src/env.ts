/**
 * Provider-neutral Worker environment. Provider adapters read their own variables from the same
 * env object (e.g. providers/alpaca/config.ts); nothing here names a provider.
 */
export interface FumeEnv {
  /** "local" enables the dev-only local authenticator (docs/security.md). Anything else fails closed. */
  FUME_ENV?: string;
  /** Comma-separated exact browser origins allowed to call the API. */
  FUME_ALLOWED_ORIGINS?: string;
  [key: string]: unknown;
}
