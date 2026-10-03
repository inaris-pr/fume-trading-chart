/**
 * Local development is loopback-only. Production verifies Access assertions server-side.
 * No identity or token is returned to the browser. Access policies choose permitted users.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './errors.ts';

export type Principal = { kind: 'local-dev' } | { kind: 'access'; subject: string };
export interface AccessSettings {
  teamDomain?: string | undefined;
  audience?: string | undefined;
}
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(
  request: Request,
  fumeEnv: string | undefined,
  access: AccessSettings = {},
): Promise<Principal> {
  const url = new URL(request.url);
  // Never trust Host/Forwarded headers to activate the local bypass.
  if (fumeEnv === 'local' && LOOPBACK_HOSTS.has(url.hostname)) {
    return { kind: 'local-dev' };
  }
  const denied = () => new ApiError(401, 'unauthorized', 'Authentication required');
  if (fumeEnv !== 'production' || url.protocol !== 'https:') throw denied();
  const issuer = access.teamDomain ?? '';
  const audience = access.audience?.trim();
  // Only an operator-configured Access team can supply keys, never a JWT's jku/iss URL.
  if (
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) ||
    !audience
  ) {
    throw denied();
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) throw denied();
  try {
    let keys = keySets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
        cacheMaxAge: 600000,
      });
      // Bound isolate memory even if configurations change repeatedly.
      if (keySets.size >= 8) keySets.delete(keySets.keys().next().value!);
      keySets.set(issuer, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer,
      audience,
      requiredClaims: ['sub', 'iat', 'exp'],
      clockTolerance: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      !Number.isFinite(payload.iat) ||
      payload.iat! > now ||
      !Number.isFinite(payload.exp) ||
      payload.exp! <= payload.iat!
    )
      throw denied();
    return { kind: 'access', subject: payload.sub };
  } catch {
    // Includes invalid signature/claims, malformed token, unknown key and JWKS outage.
    // Never log the token, headers, provider response, or underlying verification error.
    throw denied();
  }
}
