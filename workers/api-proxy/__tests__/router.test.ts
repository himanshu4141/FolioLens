import { isPublicStorageGet, matchRoute } from '../src/router';

describe('matchRoute', () => {
  it.each(['/auth/v1', '/rest/v1', '/storage/v1', '/functions/v1'])(
    'matches the bare prefix %s',
    (prefix) => {
      expect(matchRoute(prefix)).toEqual({ prefix });
    },
  );

  it.each([
    ['/rest/v1/user_profile', '/rest/v1'],
    ['/auth/v1/token?grant_type=pkce', '/auth/v1'],
    ['/storage/v1/object/public/static-snapshots/index/nifty500tri.json', '/storage/v1'],
    ['/functions/v1/parse-cas-pdf', '/functions/v1'],
  ])('matches %s under prefix %s', (pathname, prefix) => {
    expect(matchRoute(pathname)).toEqual({ prefix });
  });

  it('does not match a look-alike path that merely shares the prefix string', () => {
    expect(matchRoute('/rest/v1extra')).toBeNull();
  });

  it('rejects unmapped paths, including Realtime (unused, no WebSocket support)', () => {
    expect(matchRoute('/realtime/v1')).toBeNull();
    expect(matchRoute('/')).toBeNull();
    expect(matchRoute('/admin')).toBeNull();
  });
});

describe('isPublicStorageGet', () => {
  it('is true for a GET on the public object path', () => {
    expect(
      isPublicStorageGet('GET', '/storage/v1/object/public/static-snapshots/index/sensex.json'),
    ).toBe(true);
  });

  it('is case-insensitive on method', () => {
    expect(
      isPublicStorageGet('get', '/storage/v1/object/public/static-snapshots/index/sensex.json'),
    ).toBe(true);
  });

  it('is false for non-GET methods on the same path', () => {
    expect(
      isPublicStorageGet('POST', '/storage/v1/object/public/static-snapshots/index/sensex.json'),
    ).toBe(false);
  });

  it('is false for a private storage path (feedback attachments)', () => {
    expect(isPublicStorageGet('GET', '/storage/v1/object/user-feedback-attachments/abc')).toBe(
      false,
    );
  });
});
