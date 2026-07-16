import { buildOriginUrl } from '../src/originUrl';

const DEV_ORIGIN = 'https://imkgazlrxtlhkfptkzjc.supabase.co';

describe('buildOriginUrl', () => {
  it('builds a plain request against the pinned origin', () => {
    const url = buildOriginUrl(DEV_ORIGIN, '/rest/v1/user_profile', '?select=*');
    expect(url.href).toBe(`${DEV_ORIGIN}/rest/v1/user_profile?select=*`);
    expect(url.host).toBe('imkgazlrxtlhkfptkzjc.supabase.co');
  });

  it('tolerates a trailing slash on the configured origin', () => {
    const url = buildOriginUrl(`${DEV_ORIGIN}/`, '/rest/v1/user_profile', '');
    expect(url.href).toBe(`${DEV_ORIGIN}/rest/v1/user_profile`);
  });

  it('never lets a protocol-relative path smuggle a different host (finding 8)', () => {
    // If this were built with `new URL(pathAndQuery, origin)` (relative
    // resolution) instead of string concatenation, a leading `//` here
    // would silently repoint the result at evil.com.
    const url = buildOriginUrl(DEV_ORIGIN, '//evil.com/rest/v1/x', '?a=1');
    expect(url.host).toBe('imkgazlrxtlhkfptkzjc.supabase.co');
    expect(url.pathname).toBe('//evil.com/rest/v1/x');
  });

  it('does not let an absolute-URL-looking path change the origin', () => {
    const url = buildOriginUrl(DEV_ORIGIN, '/rest/v1/https://evil.com/x', '');
    expect(url.host).toBe('imkgazlrxtlhkfptkzjc.supabase.co');
  });

  it('never derives the origin from anything other than the configured constant', () => {
    // Simulates a spoofed Host by simply never accepting one as an input —
    // buildOriginUrl's signature has no request/header parameter at all.
    const spoofedPath = '/rest/v1/x';
    const url = buildOriginUrl(DEV_ORIGIN, spoofedPath, '');
    expect(url.origin).toBe(DEV_ORIGIN);
  });
});
