/**
 * Thin Cloudflare Worker runtime entry for the FolioLens backend proxy.
 *
 * All routing/mapping/caching DECISIONS live in pure, Jest-unit-tested
 * modules (`router.ts`, `originUrl.ts`, `headers.ts`, `cache.ts`). This
 * file only wires those decisions to the real Workers runtime (`fetch`,
 * `caches.default`, `ExecutionContext`) — see docs/research/
 * prod-backend-proxy-foliolens-domain-2026-07-16.md for the design.
 *
 * Excluded from the root tsconfig/eslint (Workers-specific globals), same
 * pattern as `supabase/functions/` for Deno.
 */
import { isCacheableResponse, cacheKeyFor, storageCacheControlHeader } from './cache';
import { applyCorsHeaders, buildForwardedRequestHeaders, buildPreflightHeaders } from './headers';
import { buildOriginUrl } from './originUrl';
import { isPublicStorageGet, matchRoute } from './router';

export interface Env {
  // Pinned per-environment Supabase origin, e.g.
  // https://imkgazlrxtlhkfptkzjc.supabase.co (dev) or
  // https://ohcaaioabjvzewfysqgh.supabase.co (prod). Set via wrangler.toml
  // `[vars]` per environment — never derived from the inbound request.
  SUPABASE_ORIGIN: string;
}

async function handlePublicStorageGet(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = cacheKeyFor(url.pathname);

  const cached = await cache.match(cacheKey);
  if (cached) {
    return applyCorsHeaders(cached);
  }

  const originUrl = buildOriginUrl(env.SUPABASE_ORIGIN, url.pathname, url.search);
  const originRequest = new Request(originUrl, {
    method: 'GET',
    headers: buildForwardedRequestHeaders(request.headers),
    redirect: 'manual',
  });
  const originResponse = await fetch(originRequest);

  if (isCacheableResponse(originResponse)) {
    const cacheHeaders = new Headers(originResponse.headers);
    cacheHeaders.set('Cache-Control', storageCacheControlHeader());
    const forCache = new Response(originResponse.clone().body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: cacheHeaders,
    });
    ctx.waitUntil(cache.put(cacheKey, forCache));
  }

  return applyCorsHeaders(originResponse);
}

async function proxyRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const originUrl = buildOriginUrl(env.SUPABASE_ORIGIN, url.pathname, url.search);
  const originRequest = new Request(originUrl, {
    method: request.method,
    headers: buildForwardedRequestHeaders(request.headers),
    // Manual: the Google OAuth `authorize` endpoint 302s to Google. That
    // redirect must reach the browser unchanged so it navigates directly
    // to Google, not get silently followed and swallowed by this
    // subrequest (which would hand the browser Google's HTML instead of
    // a redirect, breaking sign-in entirely).
    redirect: 'manual',
    body: request.body,
  });
  const originResponse = await fetch(originRequest);
  return applyCorsHeaders(originResponse);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);

    // No open relay: anything outside the four mapped prefixes (including
    // Realtime, which the app doesn't use) 404s before touching the origin.
    if (!route) {
      return new Response('Not found', { status: 404 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: buildPreflightHeaders(request.headers) });
    }

    if (isPublicStorageGet(request.method, url.pathname)) {
      return handlePublicStorageGet(request, env, ctx, url);
    }

    return proxyRequest(request, env, url);
  },
};
