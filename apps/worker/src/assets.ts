import { authenticate } from './auth.ts';
import type { FumeEnv } from './env.ts';
import { ApiError, errorBody, toApiError } from './errors.ts';

/** Called only for non-API paths. Worker-first routing protects every asset/navigation. */
export async function serveFrontend(request: Request, env: FumeEnv): Promise<Response> {
  try {
    await authenticate(request, env.FUME_ENV, {
      teamDomain: env.FUME_ACCESS_TEAM_DOMAIN,
      audience: env.FUME_ACCESS_AUD,
    });
    if (request.headers.has('Upgrade')) throw new ApiError(404, 'not_found', 'No such route');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new ApiError(405, 'invalid_request', 'Method not allowed');
    }
    if (!env.ASSETS) {
      if (env.FUME_ENV === 'local') throw new ApiError(404, 'not_found', 'No such route');
      throw new ApiError(503, 'unavailable', 'Frontend assets are not configured');
    }
    const headers = new Headers(request.headers);
    for (const name of ['Cf-Access-Jwt-Assertion', 'Cookie', 'Authorization']) headers.delete(name);
    const asset = await env.ASSETS.fetch(new Request(request, { headers }));
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'same-origin');
    return response;
  } catch (error) {
    const safe = toApiError(error);
    return Response.json(errorBody(safe), {
      status: safe.status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(safe.status === 405 ? { Allow: 'GET, HEAD' } : {}),
      },
    });
  }
}
