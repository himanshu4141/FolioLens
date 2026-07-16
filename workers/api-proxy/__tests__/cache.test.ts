import { cacheKeyFor, isCacheableResponse, storageCacheControlHeader } from '../src/cache';

describe('cacheKeyFor', () => {
  it('produces distinct keys for distinct object paths (finding 6 correctness property)', () => {
    const a = cacheKeyFor('/storage/v1/object/public/static-snapshots/index/nifty500tri.json');
    const b = cacheKeyFor('/storage/v1/object/public/static-snapshots/index/sensex.json');
    expect(a).not.toBe(b);
  });

  it('is stable for the same path across calls (a hit is possible at all)', () => {
    const path = '/storage/v1/object/public/static-snapshots/index/nifty500tri.json';
    expect(cacheKeyFor(path)).toBe(cacheKeyFor(path));
  });

  it('never returns a key equal to a different symbol’s key, even sharing a common prefix', () => {
    const nifty = cacheKeyFor('/storage/v1/object/public/static-snapshots/index/nifty.json');
    const nifty500 = cacheKeyFor('/storage/v1/object/public/static-snapshots/index/nifty500.json');
    expect(nifty).not.toBe(nifty500);
  });
});

describe('storageCacheControlHeader', () => {
  it('sets a max-age and stale-while-revalidate comparable to the CDN snapshot design', () => {
    const header = storageCacheControlHeader();
    expect(header).toContain('public');
    expect(header).toContain('max-age=');
    expect(header).toContain('stale-while-revalidate=86400');
  });
});

describe('isCacheableResponse', () => {
  it('is true for a 200 response', () => {
    expect(isCacheableResponse(new Response('{}', { status: 200 }))).toBe(true);
  });

  it('is false for a 404, so a miss is never cached (fallback path stays live)', () => {
    expect(isCacheableResponse(new Response(null, { status: 404 }))).toBe(false);
  });
});
