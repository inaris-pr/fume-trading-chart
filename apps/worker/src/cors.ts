/**
 * Origin policy (docs/security.md, step 1). This limits which BROWSER pages may call Fume; it is
 * not authentication. FUME_ALLOWED_ORIGINS is a comma-separated list of exact origins
 * (scheme + host + port). CORS headers name the exact allowed origin, never `*`.
 */
import { ApiError } from './errors.ts';

export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const raw of (value ?? '').split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue; // malformed entries are ignored (fail closed: they allow nothing)
    }
    // Only exact origins: no path, query, wildcard or credentials.
    if (url.origin !== trimmed || trimmed.includes('*')) continue;
    origins.add(url.origin);
  }
  return origins;
}

/**
 * Checks the request's Origin header. No Origin (server-to-server, curl, same-origin GET) passes
 * this step and goes on to authentication. A present but unlisted Origin (including "null") is
 * rejected with 403 forbidden_origin.
 */
export function checkOrigin(request: Request, allowed: ReadonlySet<string>): string | null {
  const origin = request.headers.get('Origin');
  if (origin === null) return null;
  if (!allowed.has(origin)) {
    throw new ApiError(403, 'forbidden_origin', 'Origin not allowed');
  }
  return origin;
}

/** Headers added to every API response. `Vary: Origin` is always set (responses differ by origin). */
export function corsHeaders(origin: string | null): Record<string, string> {
  return origin === null
    ? { Vary: 'Origin' }
    : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/** Response to a CORS preflight from an allowed origin (or a bare OPTIONS without Origin). */
export function preflightResponse(origin: string | null): Response {
  const headers: Record<string, string> = { ...corsHeaders(origin) };
  if (origin !== null) {
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '600';
  }
  return new Response(null, { status: 204, headers });
}
