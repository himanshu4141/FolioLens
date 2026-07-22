import Constants from 'expo-constants';

const DEFAULT_NATIVE_BRIDGE_BASE_URL = 'https://app.foliolens.in';

const SUPPORTED_APP_SCHEMES = new Set([
  'foliolens',
  'foliolens-dev',
  'foliolens-main',
  'foliolens-pr',
]);

const API_PROXY_HOST_TO_WEB_BRIDGE_ORIGIN: Record<string, string> = {
  'api.foliolens.in': 'https://app.foliolens.in',
  'api-dev.foliolens.in': 'https://foliolens-dev.vercel.app',
};

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

export function normalizeAppBaseOrigin(configuredBaseUrl: string): string | null {
  try {
    const parsedBaseUrl = new URL(configuredBaseUrl);
    return API_PROXY_HOST_TO_WEB_BRIDGE_ORIGIN[parsedBaseUrl.hostname] ?? parsedBaseUrl.origin;
  } catch {
    return null;
  }
}

export function getNativeBridgeBaseUrl(): string {
  const configuredBaseUrl = process.env.EXPO_PUBLIC_APP_BASE_URL ?? DEFAULT_NATIVE_BRIDGE_BASE_URL;
  return normalizeAppBaseOrigin(configuredBaseUrl) ?? DEFAULT_NATIVE_BRIDGE_BASE_URL;
}

export function getNativeBridgeUrl(path: '/auth/confirm' | '/auth/callback'): string {
  const scheme = encodeURIComponent(getAppScheme());
  const baseUrl = getNativeBridgeBaseUrl();
  return `${baseUrl}${path}?scheme=${scheme}`;
}

export function isSupportedAppScheme(scheme: string): boolean {
  return SUPPORTED_APP_SCHEMES.has(scheme);
}

export function shouldBridgeToNativeApp(params: {
  userAgent: string;
  currentHostname: string;
  hasNativeSchemeParam: boolean;
  targetScheme: string;
}): boolean {
  if (!params.hasNativeSchemeParam) return false;
  if (!isSupportedAppScheme(params.targetScheme)) return false;
  if (!/iphone|ipad|ipod|android/.test(params.userAgent.toLowerCase())) return false;
  const bridgeHostname = new URL(getNativeBridgeBaseUrl()).hostname;
  return params.currentHostname === bridgeHostname;
}
