/**
 * Extract the PKCE authorization code from an OAuth callback URL.
 *
 * Works with both custom scheme and HTTPS URLs:
 *   fundlens://auth/callback?code=abc123
 *   https://example.com/auth/callback?code=abc123
 *
 * Returns null if no code is present (error redirect or cancelled flow).
 */
export function parseOAuthCode(url: string): string | null {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return null;
  // Strip any trailing hash fragment so it doesn't pollute the query string
  const queryString = url.slice(queryStart + 1).split('#')[0];
  return new URLSearchParams(queryString).get('code');
}

export function parseSessionFromUrl(url: string): {
  accessToken: string;
  refreshToken: string;
} | null {
  const fragment = url.split('#')[1];
  if (!fragment) return null;

  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  if (!accessToken || !refreshToken) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
  };
}

export type OAuthCallbackPayload =
  | { type: 'code'; code: string }
  | { type: 'fragment'; accessToken: string; refreshToken: string }
  | { type: 'error'; error: string }
  | { type: 'invalid' };

/**
 * Parse an OAuth callback without logging or persisting its credentials.
 * New flows use `code`; fragment tokens are accepted only for callbacks
 * initiated by an older implicit-flow bundle during rollout.
 */
export function parseOAuthCallback(url: string): OAuthCallbackPayload {
  const code = parseOAuthCode(url);
  if (code) return { type: 'code', code };

  const session = parseSessionFromUrl(url);
  if (session) {
    return {
      type: 'fragment',
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  const queryStart = url.indexOf('?');
  if (queryStart !== -1) {
    const queryString = url.slice(queryStart + 1).split('#')[0];
    const error = new URLSearchParams(queryString).get('error');
    if (error) return { type: 'error', error };
  }

  return { type: 'invalid' };
}

/** Native magic links are the only fragment callbacks owned by RootLayout. */
export function isNativeMagicLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'auth' && parsed.pathname === '/confirm';
  } catch {
    return false;
  }
}

export function buildNativeOAuthCallbackUrl(params: {
  scheme: string;
  code?: string;
  error?: string;
}): string | null {
  const search = new URLSearchParams();
  if (params.code) search.set('code', params.code);
  if (params.error) search.set('error', params.error);
  const query = search.toString();
  return query ? `${params.scheme}://auth/callback?${query}` : null;
}

export function resolveNativeOAuthCallbackUrl(params: {
  scheme: string;
  callbackUrl?: string;
  incomingUrl?: string | null;
  code?: string;
  error?: string;
}): string | null {
  if (params.callbackUrl) return params.callbackUrl;
  return buildNativeOAuthCallbackUrl(params) ?? params.incomingUrl ?? null;
}
