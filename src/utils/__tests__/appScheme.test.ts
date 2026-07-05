import Constants from 'expo-constants';
import {
  getAppScheme,
  getNativeAuthOrigin,
  getNativeBridgeUrl,
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

});
