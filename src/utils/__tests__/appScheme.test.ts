import Constants from 'expo-constants';
import {
  getAppScheme,
  getNativeAuthOrigin,
  getNativeBridgeBaseUrl,
  getNativeBridgeUrl,
  isSupportedAppScheme,
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

  it('normalizes accidental API proxy base URLs back to web bridge hosts', () => {
    constants.expoConfig = {
      extra: { appScheme: 'foliolens-pr' },
    };
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://api-dev.foliolens.in';

    expect(getNativeBridgeBaseUrl()).toBe('https://foliolens-dev.vercel.app');
    expect(getNativeBridgeUrl('/auth/callback')).toBe(
      'https://foliolens-dev.vercel.app/auth/callback?scheme=foliolens-pr',
    );

    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://api.foliolens.in';

    expect(getNativeBridgeBaseUrl()).toBe('https://app.foliolens.in');
    expect(getNativeBridgeUrl('/auth/callback')).toBe(
      'https://app.foliolens.in/auth/callback?scheme=foliolens-pr',
    );
  });

  it('falls back to the production bridge when the configured base URL is invalid', () => {
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'not a url';

    expect(getNativeBridgeBaseUrl()).toBe('https://app.foliolens.in');
  });

  describe('isSupportedAppScheme', () => {
    it.each(['foliolens', 'foliolens-dev', 'foliolens-main', 'foliolens-pr'])(
      'accepts the known installed app scheme %s',
      (scheme) => {
        expect(isSupportedAppScheme(scheme)).toBe(true);
      },
    );

    it('rejects arbitrary schemes from bridge query params', () => {
      expect(isSupportedAppScheme('evil-app')).toBe(false);
      expect(isSupportedAppScheme('https')).toBe(false);
    });
  });

  describe('shouldBridgeToNativeApp', () => {
    const mobileUserAgent =
      'Mozilla/5.0 (Linux; Android 16; Pixel 8a) AppleWebKit/537.36 Mobile Safari/537.36';
    const desktopUserAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    it('bridges native-initiated magic-link web callbacks on the configured mobile bridge host', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: true,
          targetScheme: 'foliolens',
        }),
      ).toBe(true);
    });

    it('does not bridge mobile web callbacks that have no native scheme marker', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: false,
          targetScheme: 'foliolens',
        }),
      ).toBe(false);
    });

    it('does not bridge unsupported scheme query params', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: true,
          targetScheme: 'evil-app',
        }),
      ).toBe(false);
    });

    it('does not bridge desktop browsers or unrelated hosts', () => {
      expect(
        shouldBridgeToNativeApp({
          userAgent: desktopUserAgent,
          currentHostname: 'app.foliolens.in',
          hasNativeSchemeParam: true,
          targetScheme: 'foliolens',
        }),
      ).toBe(false);

      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'random-preview.vercel.app',
          hasNativeSchemeParam: true,
          targetScheme: 'foliolens',
        }),
      ).toBe(false);
    });

    it('honours the DEV bridge host when configured', () => {
      process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://foliolens-dev.vercel.app';

      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'foliolens-dev.vercel.app',
          hasNativeSchemeParam: true,
          targetScheme: 'foliolens-pr',
        }),
      ).toBe(true);
    });

    it('bridges on the DEV web host when APP_BASE_URL was accidentally set to the DEV API proxy', () => {
      process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://api-dev.foliolens.in';

      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'foliolens-dev.vercel.app',
          hasNativeSchemeParam: true,
          targetScheme: 'foliolens-pr',
        }),
      ).toBe(true);

      expect(
        shouldBridgeToNativeApp({
          userAgent: mobileUserAgent,
          currentHostname: 'api-dev.foliolens.in',
          hasNativeSchemeParam: true,
          targetScheme: 'foliolens-pr',
        }),
      ).toBe(false);
    });
  });

});
