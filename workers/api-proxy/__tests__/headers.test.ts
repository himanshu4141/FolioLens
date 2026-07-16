import {
  applyCorsHeaders,
  buildForwardedRequestHeaders,
  buildPreflightHeaders,
  buildPublicStorageForwardedHeaders,
} from '../src/headers';

describe('buildForwardedRequestHeaders', () => {
  it('forwards Authorization, apikey, and Content-Type unchanged', () => {
    const input = new Headers({
      Authorization: 'Bearer abc.def.ghi',
      apikey: 'anon-key',
      'Content-Type': 'application/json',
    });
    const forwarded = buildForwardedRequestHeaders(input);
    expect(forwarded.get('authorization')).toBe('Bearer abc.def.ghi');
    expect(forwarded.get('apikey')).toBe('anon-key');
    expect(forwarded.get('content-type')).toBe('application/json');
  });

  it('does not synthesise or strip a cookie header if one is present', () => {
    const input = new Headers({ Cookie: 'some=value' });
    const forwarded = buildForwardedRequestHeaders(input);
    expect(forwarded.get('cookie')).toBe('some=value');
  });

  it('forwards PostgREST-specific headers (Prefer, Range)', () => {
    const input = new Headers({ Prefer: 'return=representation', Range: '0-999' });
    const forwarded = buildForwardedRequestHeaders(input);
    expect(forwarded.get('prefer')).toBe('return=representation');
    expect(forwarded.get('range')).toBe('0-999');
  });

  it('strips hop-by-hop / Cloudflare-injected headers that would identify the proxy hop', () => {
    const input = new Headers({
      Host: 'api-dev.foliolens.in',
      'CF-Connecting-IP': '203.0.113.5',
      'CF-Ray': 'abc123',
      Authorization: 'Bearer token',
    });
    const forwarded = buildForwardedRequestHeaders(input);
    expect(forwarded.has('host')).toBe(false);
    expect(forwarded.has('cf-connecting-ip')).toBe(false);
    expect(forwarded.has('cf-ray')).toBe(false);
    expect(forwarded.get('authorization')).toBe('Bearer token');
  });
});

describe('buildPublicStorageForwardedHeaders', () => {
  it('carries no caller-supplied header at all — not Authorization, apikey, Cookie, or conditional-request headers', () => {
    // This function deliberately takes no request argument: the cacheable
    // public-storage path must never forward anything caller-supplied,
    // since the cache key (finding 6) ignores headers and a
    // header-dependent response could otherwise leak to a different
    // caller (round-1 review finding).
    const headers = buildPublicStorageForwardedHeaders();
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('apikey')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('if-none-match')).toBe(false);
    expect(headers.has('if-modified-since')).toBe(false);
    // A forwarded Range would let a byte-range request produce a 206
    // that gets cached under the full-object key (round-1 review finding,
    // paired with cache.ts's isCacheableResponse now excluding 206 too).
    expect(headers.has('range')).toBe(false);
    expect(headers.get('accept')).toBe('application/json');
  });
});

describe('buildPreflightHeaders', () => {
  it('echoes Access-Control-Request-Headers when present', () => {
    const input = new Headers({ 'Access-Control-Request-Headers': 'authorization, apikey' });
    const headers = buildPreflightHeaders(input);
    expect(headers.get('access-control-allow-headers')).toBe('authorization, apikey');
    expect(headers.get('access-control-allow-origin')).toBe('*');
  });

  it('falls back to a default allow-list when the browser sends none', () => {
    const headers = buildPreflightHeaders(new Headers());
    expect(headers.get('access-control-allow-headers')).toEqual(expect.stringContaining('authorization'));
  });
});

describe('applyCorsHeaders', () => {
  it('sets Access-Control-Allow-Origin on the response regardless of the origin response', async () => {
    const origin = new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const result = applyCorsHeaders(origin);
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('{"ok":true}');
  });

  it('sets a marker header proving the Worker produced this response (vs. a zone-level cache serving it unseen)', () => {
    const origin = new Response(null, { status: 204 });
    const result = applyCorsHeaders(origin);
    expect(result.headers.get('x-foliolens-api-proxy')).toBe('1');
  });

  it('preserves an existing distinct Access-Control-Allow-Origin by overriding to the permissive value', () => {
    const origin = new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': 'https://example.com' },
    });
    const result = applyCorsHeaders(origin);
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
  });
});
