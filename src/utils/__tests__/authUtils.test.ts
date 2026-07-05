import {
  buildNativeOAuthCallbackUrl,
  isNativeMagicLinkUrl,
  parseOAuthCallback,
  parseOAuthCode,
  parseSessionFromUrl,
  resolveNativeOAuthCallbackUrl,
} from '../authUtils';

// ---------------------------------------------------------------------------
// parseOAuthCode
// ---------------------------------------------------------------------------

describe('parseOAuthCode', () => {
  describe('returns the code when present in the query string', () => {
    it('extracts code from a custom scheme callback URL', () => {
      expect(parseOAuthCode('fundlens://auth/callback?code=abc123')).toBe('abc123');
    });

    it('extracts code from an HTTPS callback URL', () => {
      expect(parseOAuthCode('https://fund-lens.vercel.app/auth/callback?code=xyz789')).toBe('xyz789');
    });

    it('extracts code when multiple query params are present', () => {
      expect(parseOAuthCode('fundlens://auth/callback?state=foo&code=bar456&scope=email')).toBe('bar456');
    });

    it('strips hash fragment before parsing so it does not interfere', () => {
      expect(parseOAuthCode('fundlens://auth/callback?code=abc&state=x#ignored')).toBe('abc');
    });

    it('decodes percent-encoded code values', () => {
      expect(parseOAuthCode('fundlens://auth/callback?code=abc%2B123')).toBe('abc+123');
    });
  });

  describe('returns null when no code is present', () => {
    it('returns null for a URL with no query string', () => {
      expect(parseOAuthCode('fundlens://auth/callback')).toBeNull();
    });

    it('returns null for an error redirect', () => {
      expect(parseOAuthCode('fundlens://auth/callback?error=access_denied&error_description=User+cancelled')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseOAuthCode('')).toBeNull();
    });

    it('returns null for a URL whose only fragment is a hash (magic-link style)', () => {
      expect(parseOAuthCode('fundlens://auth/confirm#access_token=xyz&refresh_token=abc')).toBeNull();
    });

    it('returns null when the query string has params but none is "code"', () => {
      expect(parseOAuthCode('fundlens://auth/callback?state=abc&scope=openid')).toBeNull();
    });
  });
});

describe('parseSessionFromUrl', () => {
  it('extracts access and refresh tokens from a fragment URL', () => {
    expect(
      parseSessionFromUrl(
        'fundlens://auth/callback#access_token=token123&refresh_token=refresh456&type=bearer',
      ),
    ).toEqual({
      accessToken: 'token123',
      refreshToken: 'refresh456',
    });
  });

  it('returns null when the fragment is missing', () => {
    expect(parseSessionFromUrl('fundlens://auth/callback?code=abc123')).toBeNull();
  });

  it('returns null when only one token is present', () => {
    expect(parseSessionFromUrl('fundlens://auth/callback#access_token=token123')).toBeNull();
  });
});

describe('parseOAuthCallback', () => {
  it('prefers the canonical PKCE code transport', () => {
    expect(parseOAuthCallback('foliolens-pr://auth/callback?code=one-time-code')).toEqual({
      type: 'code',
      code: 'one-time-code',
    });
  });

  it('keeps legacy fragment tokens as a compatibility transport', () => {
    expect(
      parseOAuthCallback(
        'foliolens-pr://auth/callback#access_token=legacy-access&refresh_token=legacy-refresh',
      ),
    ).toEqual({
      type: 'fragment',
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
    });
  });

  it('classifies provider errors without retaining their description', () => {
    expect(
      parseOAuthCallback(
        'foliolens-pr://auth/callback?error=access_denied&error_description=user%40example.com',
      ),
    ).toEqual({ type: 'error', error: 'access_denied' });
  });

  it('rejects callbacks without a supported transport', () => {
    expect(parseOAuthCallback('foliolens-pr://auth/callback?state=opaque')).toEqual({
      type: 'invalid',
    });
  });
});

describe('native auth route helpers', () => {
  it('recognises only the native magic-link confirmation route', () => {
    expect(
      isNativeMagicLinkUrl(
        'foliolens-main://auth/confirm#access_token=one&refresh_token=two',
      ),
    ).toBe(true);
    expect(isNativeMagicLinkUrl('foliolens-main://auth/callback?code=one')).toBe(false);
    expect(isNativeMagicLinkUrl('https://app.foliolens.in/auth/confirm')).toBe(false);
  });

  it('reconstructs late Expo Router callback params without leaking extra fields', () => {
    expect(
      buildNativeOAuthCallbackUrl({
        scheme: 'foliolens-pr',
        code: 'abc+123',
      }),
    ).toBe('foliolens-pr://auth/callback?code=abc%2B123');
    expect(
      buildNativeOAuthCallbackUrl({
        scheme: 'foliolens-pr',
        error: 'access_denied',
      }),
    ).toBe('foliolens-pr://auth/callback?error=access_denied');
    expect(buildNativeOAuthCallbackUrl({ scheme: 'foliolens-pr' })).toBeNull();
  });

  it('waits for late Router params and then prefers them over a stale Linking URL', () => {
    expect(resolveNativeOAuthCallbackUrl({ scheme: 'foliolens-pr' })).toBeNull();
    expect(
      resolveNativeOAuthCallbackUrl({
        scheme: 'foliolens-pr',
        code: 'late-code',
        incomingUrl: 'foliolens-pr://auth/confirm#access_token=stale',
      }),
    ).toBe('foliolens-pr://auth/callback?code=late-code');
  });

  it('prefers an explicit callback URL delivered by WebBrowser routing', () => {
    expect(
      resolveNativeOAuthCallbackUrl({
        scheme: 'foliolens-pr',
        callbackUrl: 'foliolens-pr://auth/callback?code=explicit',
        code: 'route-param',
      }),
    ).toBe('foliolens-pr://auth/callback?code=explicit');
  });
});
