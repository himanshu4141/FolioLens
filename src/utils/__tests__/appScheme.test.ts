import Constants from 'expo-constants';
import {
  getAppScheme,
  getNativeAuthOrigin,
  getNativeBridgeUrl,
  shouldBridgeToNativeApp,
} from '../appScheme';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {},
  },
}));

type ExpoConstantsShape = {
  expoConfig?: {
    extra?: {
      appScheme?: string;
    };
    scheme?: string;
  };
};

describe('appScheme helpers', () => {
  const originalEnv = process.env.EXPO_PUBLIC_APP_SCHEME;
  const originalBaseUrl = process.env.EXPO_PUBLIC_APP_BASE_URL;
  const constants = Constants as ExpoConstantsShape;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_APP_SCHEME;
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://app.foliolens.in';
    constants.expoConfig = {};
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.EXPO_PUBLIC_APP_SCHEME;
    } else {
      process.env.EXPO_PUBLIC_APP_SCHEME = originalEnv;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.EXPO_PUBLIC_APP_BASE_URL;
    } else {
      process.env.EXPO_PUBLIC_APP_BASE_URL = originalBaseUrl;
    }
  });

  it('prefers expo extra appScheme when available', () => {
    constants.expoConfig = {
      extra: { appScheme: 'foliolens-pr' },
      scheme: 'foliolens',
    };

    expect(getAppScheme()).toBe('foliolens-pr');
  });

  it('falls back to expoConfig.scheme when extra appScheme is missing', () => {
    constants.expoConfig = {
      scheme: 'foliolens-main',
    };

    expect(getAppScheme()).toBe('foliolens-main');
  });

  it('falls back to EXPO_PUBLIC_APP_SCHEME when expo config is unavailable', () => {
    process.env.EXPO_PUBLIC_APP_SCHEME = 'foliolens-dev';

    expect(getAppScheme()).toBe('foliolens-dev');
  });

  it('defaults to foliolens when no override exists', () => {
    expect(getAppScheme()).toBe('foliolens');
  });

  it('builds the native auth origin from the resolved scheme', () => {
    constants.expoConfig = {
      extra: { appScheme: 'foliolens-main' },
    };

    expect(getNativeAuthOrigin()).toBe('foliolens-main://');
  });

  it('builds confirm and callback bridge URLs with an encoded scheme', () => {
    constants.expoConfig = {
      extra: { appScheme: 'foliolens pr' },
    };

    expect(getNativeBridgeUrl('/auth/confirm')).toBe(
      'https://app.foliolens.in/auth/confirm?scheme=foliolens%20pr',
    );
    expect(getNativeBridgeUrl('/auth/callback')).toBe(
      'https://app.foliolens.in/auth/callback?scheme=foliolens%20pr',
    );
  });

  describe('shouldBridgeToNativeApp', () => {
    const IPHONE_UA =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    const DESKTOP_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    it('bridges a native-initiated flow (scheme marker) on mobile at the bridge host', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: IPHONE_UA,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: true,
        }),
      ).toBe(true);
    });

    it('does NOT bridge a web-initiated sign-in (no scheme) on mobile at the bridge host', () => {
      // Regression: a mobile-web Google / magic-link callback lands on the
      // bridge host without a `?scheme=` marker and must complete as a web
      // session. Bouncing it to `foliolens://` stranded the visitor in the
      // browser, unauthenticated.
      expect(
        shouldBridgeToNativeApp({
          userAgent: IPHONE_UA,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: false,
        }),
      ).toBe(false);
    });

    it('does NOT bridge on desktop even for a native-initiated flow', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: DESKTOP_UA,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: true,
        }),
      ).toBe(false);
    });

    it('does NOT bridge when the current host is not the configured bridge host', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: IPHONE_UA,
          currentHostname: 'random-preview.vercel.app',
          hasNativeSchemeParam: true,
        }),
      ).toBe(false);
    });

    it('honours a dev bridge host from EXPO_PUBLIC_APP_BASE_URL', () => {
      process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://foliolens-dev.vercel.app';

      expect(
        shouldBridgeToNativeApp({
          userAgent: IPHONE_UA,
          currentHostname: 'foliolens-dev.vercel.app',
          hasNativeSchemeParam: true,
        }),
      ).toBe(true);
      // ...and still refuses the web-initiated flow on that same dev host,
      // where the web app and the native-bridge host are one and the same.
      expect(
        shouldBridgeToNativeApp({
          userAgent: IPHONE_UA,
          currentHostname: 'foliolens-dev.vercel.app',
          hasNativeSchemeParam: false,
        }),
      ).toBe(false);
    });
  });

});
