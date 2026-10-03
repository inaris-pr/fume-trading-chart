/** Backend-only bindings and configuration. Never serialized into frontend bootstrap data. */
export interface FumeEnv {
  FUME_ENV?: string;
  FUME_ALLOWED_ORIGINS?: string;
  FUME_ACCESS_TEAM_DOMAIN?: string;
  FUME_ACCESS_AUD?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
}
