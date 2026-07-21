import Constants from 'expo-constants';

export function getAppScheme(): string {
  const extraScheme = Constants.expoConfig?.extra?.appScheme;
  const configScheme = Constants.expoConfig?.scheme;

  if (typeof extraScheme === 'string' && extraScheme.length > 0) return extraScheme;
  if (typeof configScheme === 'string' && configScheme.length > 0) return configScheme;
  if (typeof process.env.EXPO_PUBLIC_APP_SCHEME === 'string' && process.env.EXPO_PUBLIC_APP_SCHEME.length > 0) {
    return process.env.EXPO_PUBLIC_APP_SCHEME;
  }

  return 'foliolens';
}

export function getNativeAuthOrigin(): string {
  return `${getAppScheme()}://`;
}

export function getNativeBridgeUrl(path: '/auth/confirm' | '/auth/callback'): string {
  const scheme = encodeURIComponent(getAppScheme());
  const baseUrl = process.env.EXPO_PUBLIC_APP_BASE_URL ?? 'https://app.foliolens.in';
  return `${baseUrl}${path}?scheme=${scheme}`;
}

/**
 * Decide whether a web auth-callback page should hand the flow off to the
 * installed native app via its custom scheme (`foliolens://`).
 *
 * The bridge exists because a *native*-initiated auth flow (magic link or
 * Google OAuth) must land on an `https://` page to satisfy email-client and
 * OAuth redirect-allowlist constraints; that page then bounces the flow back
 * into the app. Native flows tag themselves with the `?scheme=` query param
 * added by `getNativeBridgeUrl`, and `EXPO_PUBLIC_APP_BASE_URL` is the host
 * they land on (the same host that serves the web app in dev and prod).
 *
 * A *web*-initiated sign-in on that same host has **no** `scheme` marker: it
 * redirects to a plain `/auth/{callback,confirm}` and must complete as a web
 * session (Supabase `detectSessionInUrl`). Deep-linking it to `foliolens://`
 * would strand a mobile-web visitor in the browser — the scheme opens nothing
 * on a device without the app, and `window.location.replace` aborts the
 * in-flight web session exchange, leaving them signed out. The `scheme`-marker
 * check is what separates the two; without it every mobile-web Google/magic
 * link sign-in on the bridge host is wrongly bounced to the app.
 */
export function shouldBridgeToNativeApp(params: {
  userAgent: string;
  currentHostname: string;
  hasNativeSchemeParam: boolean;
}): boolean {
  if (!params.hasNativeSchemeParam) return false;
  if (!/iphone|ipad|ipod|android/.test(params.userAgent.toLowerCase())) return false;
  const bridgeHostname = new URL(
    process.env.EXPO_PUBLIC_APP_BASE_URL ?? 'https://app.foliolens.in',
  ).hostname;
  return params.currentHostname === bridgeHostname;
}
