import {
  formatInboxAddress,
  getInboxDomain,
  getInboxEnvironment,
  isValidInboxToken,
  parseInboxToken,
} from '../casInboxToken';
import Constants from 'expo-constants';

jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {
      appVariant: 'production',
    },
  },
}));

const ENV_BACKUP = process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
const INBOUND_ENV_BACKUP = process.env.EXPO_PUBLIC_INBOUND_ENV;
const SUPABASE_URL_BACKUP = process.env.EXPO_PUBLIC_SUPABASE_URL;
const APP_BASE_URL_BACKUP = process.env.EXPO_PUBLIC_APP_BASE_URL;

type MockConstants = {
  expoConfig?: {
    extra?: {
      appVariant?: string;
    };
  };
};

afterEach(() => {
  if (ENV_BACKUP === undefined) {
    delete process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
  } else {
    process.env.EXPO_PUBLIC_INBOUND_DOMAIN = ENV_BACKUP;
  }
  if (INBOUND_ENV_BACKUP === undefined) {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
  } else {
    process.env.EXPO_PUBLIC_INBOUND_ENV = INBOUND_ENV_BACKUP;
  }
  if (SUPABASE_URL_BACKUP === undefined) {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  } else {
    process.env.EXPO_PUBLIC_SUPABASE_URL = SUPABASE_URL_BACKUP;
  }
  if (APP_BASE_URL_BACKUP === undefined) {
    delete process.env.EXPO_PUBLIC_APP_BASE_URL;
  } else {
    process.env.EXPO_PUBLIC_APP_BASE_URL = APP_BASE_URL_BACKUP;
  }
  (Constants as MockConstants).expoConfig = {
    extra: {
      appVariant: 'production',
    },
  };
});

describe('getInboxDomain', () => {
  it('returns the prod default when env is unset', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
    expect(getInboxDomain()).toBe('foliolens.in');
  });

  it('returns the configured domain when env is set', () => {
    process.env.EXPO_PUBLIC_INBOUND_DOMAIN = 'mail.example.com';
    expect(getInboxDomain()).toBe('mail.example.com');
  });

  it('falls back to prod default when env is empty string', () => {
    process.env.EXPO_PUBLIC_INBOUND_DOMAIN = '';
    expect(getInboxDomain()).toBe('foliolens.in');
  });
});

describe('getInboxEnvironment', () => {
  it('defaults to prod', () => {
    expect(getInboxEnvironment()).toBe('prod');
  });

  it('honours an explicit public inbound env', () => {
    process.env.EXPO_PUBLIC_INBOUND_ENV = 'dev';
    expect(getInboxEnvironment()).toBe('dev');

    process.env.EXPO_PUBLIC_INBOUND_ENV = 'prod';
    expect(getInboxEnvironment()).toBe('prod');
  });

  it('treats non-production app variants as dev', () => {
    (Constants as MockConstants).expoConfig = {
      extra: {
        appVariant: 'preview-pr',
      },
    };
    expect(getInboxEnvironment()).toBe('dev');
  });

  it('falls back to Supabase project refs for web builds', () => {
    (Constants as MockConstants).expoConfig = { extra: {} };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://imkgazlrxtlhkfptkzjc.supabase.co';
    expect(getInboxEnvironment()).toBe('dev');

    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://ohcaaioabjvzewfysqgh.supabase.co';
    expect(getInboxEnvironment()).toBe('prod');
  });

  // Backend-proxy program (D2): once the client points at api(-dev).foliolens.in,
  // neither project ref substring ever appears in EXPO_PUBLIC_SUPABASE_URL —
  // env resolution must not rely on that host containing a supabase.co ref.

  it('resolves prod via explicit inbound env when the backend base is the proxy host', () => {
    process.env.EXPO_PUBLIC_INBOUND_ENV = 'prod';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api.foliolens.in';
    expect(getInboxEnvironment()).toBe('prod');
  });

  it('resolves dev via explicit inbound env when the backend base is the dev proxy host', () => {
    process.env.EXPO_PUBLIC_INBOUND_ENV = 'dev';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api-dev.foliolens.in';
    expect(getInboxEnvironment()).toBe('dev');
  });

  it('resolves prod via appVariant=production when the backend base is the proxy host (no ref substring present)', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
    (Constants as MockConstants).expoConfig = { extra: { appVariant: 'production' } };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api.foliolens.in';
    expect(getInboxEnvironment()).toBe('prod');
  });

  it('resolves dev via a non-production appVariant when the backend base is the dev proxy host (no ref substring present)', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
    (Constants as MockConstants).expoConfig = { extra: { appVariant: 'preview-main' } };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api-dev.foliolens.in';
    expect(getInboxEnvironment()).toBe('dev');
  });

  it('resolves prod via app base URL when variant is unset and the backend base is the proxy host', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
    (Constants as MockConstants).expoConfig = { extra: {} };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api.foliolens.in';
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://app.foliolens.in';
    expect(getInboxEnvironment()).toBe('prod');
  });

  it('resolves prod via normalized app base URL when variant is unset and APP_BASE_URL is the prod proxy host', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
    (Constants as MockConstants).expoConfig = { extra: {} };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api.foliolens.in';
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://api.foliolens.in';
    expect(getInboxEnvironment()).toBe('prod');
  });

  it('resolves dev via app base URL when variant is unset and the backend base is the dev proxy host', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
    (Constants as MockConstants).expoConfig = { extra: {} };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api-dev.foliolens.in';
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://foliolens-dev.vercel.app';
    expect(getInboxEnvironment()).toBe('dev');
  });

  it('resolves dev via normalized app base URL when variant is unset and APP_BASE_URL is the dev proxy host', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_ENV;
    (Constants as MockConstants).expoConfig = { extra: {} };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api-dev.foliolens.in';
    process.env.EXPO_PUBLIC_APP_BASE_URL = 'https://api-dev.foliolens.in';
    expect(getInboxEnvironment()).toBe('dev');
  });

  it('never needs the ref-substring fallback once appVariant or app base URL is present', () => {
    // Sanity check on ordering: a dev ref embedded in the URL must not
    // override a positive prod signal from variant/app-base-url.
    (Constants as MockConstants).expoConfig = { extra: { appVariant: 'production' } };
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://imkgazlrxtlhkfptkzjc.supabase.co';
    expect(getInboxEnvironment()).toBe('prod');
  });
});

describe('isValidInboxToken', () => {
  it('accepts an 8-char unambiguous-base32 token', () => {
    expect(isValidInboxToken('A2B3C4D5')).toBe(true);
    expect(isValidInboxToken('ZZZZZZZZ')).toBe(true);
    expect(isValidInboxToken('22222222')).toBe(true);
  });

  it('rejects ambiguous characters (0, O, 1, I, L)', () => {
    expect(isValidInboxToken('A0B3C4D5')).toBe(false);
    expect(isValidInboxToken('AOB3C4D5')).toBe(false);
    expect(isValidInboxToken('A1B3C4D5')).toBe(false);
    expect(isValidInboxToken('AIB3C4D5')).toBe(false);
    expect(isValidInboxToken('ALB3C4D5')).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(isValidInboxToken('A2B3C4D')).toBe(false);
    expect(isValidInboxToken('A2B3C4D5E')).toBe(false);
    expect(isValidInboxToken('')).toBe(false);
  });

  it('rejects lowercase (canonical form is uppercase)', () => {
    expect(isValidInboxToken('a2b3c4d5')).toBe(false);
  });
});

describe('formatInboxAddress', () => {
  it('builds the canonical cas-token address on prod', () => {
    delete process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
    expect(formatInboxAddress('A2B3C4D5')).toBe('cas-A2B3C4D5@foliolens.in');
  });

  it('builds the dev local-part address when running a dev variant', () => {
    (Constants as MockConstants).expoConfig = {
      extra: {
        appVariant: 'preview-main',
      },
    };
    expect(formatInboxAddress('A2B3C4D5')).toBe('cas-dev-A2B3C4D5@foliolens.in');
  });

  it('throws on invalid tokens so UI never renders a broken address', () => {
    expect(() => formatInboxAddress('a2b3c4d5')).toThrow();
    expect(() => formatInboxAddress('NOPE')).toThrow();
  });

  it('renders the prod address with a prod base of api.foliolens.in', () => {
    process.env.EXPO_PUBLIC_INBOUND_ENV = 'prod';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api.foliolens.in';
    delete process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
    expect(formatInboxAddress('A2B3C4D5')).toBe('cas-A2B3C4D5@foliolens.in');
  });

  it('renders the dev address with a dev base of api-dev.foliolens.in', () => {
    process.env.EXPO_PUBLIC_INBOUND_ENV = 'dev';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://api-dev.foliolens.in';
    delete process.env.EXPO_PUBLIC_INBOUND_DOMAIN;
    expect(formatInboxAddress('A2B3C4D5')).toBe('cas-dev-A2B3C4D5@foliolens.in');
  });
});

describe('parseInboxToken', () => {
  it('extracts a bare email', () => {
    expect(parseInboxToken('cas-A2B3C4D5@foliolens.in')).toBe('A2B3C4D5');
    expect(parseInboxToken('cas-dev-A2B3C4D5@foliolens.in')).toBe('A2B3C4D5');
  });

  it('handles angle-bracket form', () => {
    expect(parseInboxToken('<cas-A2B3C4D5@foliolens.in>')).toBe('A2B3C4D5');
  });

  it('handles display-name form', () => {
    expect(parseInboxToken('FolioLens Inbox <cas-dev-A2B3C4D5@foliolens.in>')).toBe('A2B3C4D5');
  });

  it('uppercases for canonical comparison', () => {
    expect(parseInboxToken('cas-a2b3c4d5@foliolens.in')).toBe('A2B3C4D5');
  });

  it('returns first match when multiple recipients are listed', () => {
    expect(parseInboxToken('foo@bar.com, cas-dev-A2B3C4D5@foliolens.in')).toBe('A2B3C4D5');
  });

  it('returns null when the address lives on a different domain', () => {
    expect(parseInboxToken('cas-A2B3C4D5@example.com')).toBeNull();
  });

  it('matches the env-resolved domain', () => {
    process.env.EXPO_PUBLIC_INBOUND_DOMAIN = 'mail.example.com';
    expect(parseInboxToken('cas-A2B3C4D5@mail.example.com')).toBe('A2B3C4D5');
    expect(parseInboxToken('cas-A2B3C4D5@foliolens.in')).toBeNull();
  });

  it('returns null when the local part is missing the cas prefix', () => {
    expect(parseInboxToken('inbox@foliolens.in')).toBeNull();
  });

  it('returns null when the token portion has invalid characters', () => {
    expect(parseInboxToken('cas-0OIL2345@foliolens.in')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseInboxToken('')).toBeNull();
    expect(parseInboxToken(null)).toBeNull();
    expect(parseInboxToken(undefined)).toBeNull();
  });
});
