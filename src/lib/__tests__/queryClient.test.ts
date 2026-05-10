jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('@/src/lib/supabase', () => ({
  supabase: { auth: { signOut: jest.fn() } },
}));

jest.mock('@/src/lib/analytics', () => ({
  analytics: { track: jest.fn() },
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import {
  PERSIST_MAX_AGE_MS,
  __BUSTER__,
  queryClient,
  shouldPersistQueryKey,
} from '@/src/lib/queryClient';
// eslint-disable-next-line import/first
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
// eslint-disable-next-line import/first
import { supabase } from '@/src/lib/supabase';
// eslint-disable-next-line import/first
import { analytics } from '@/src/lib/analytics';

const mockedSignOut = supabase.auth.signOut as jest.MockedFunction<typeof supabase.auth.signOut>;
const mockedTrack = analytics.track as jest.MockedFunction<typeof analytics.track>;

describe('shouldPersistQueryKey()', () => {
  describe('persists', () => {
    it.each([
      ['portfolio aggregate', ['portfolio', 'user-1', '^NSEI']],
      ['nav-history', ['nav-history', 'user-1', [12345]]],
      ['index-history', ['index-history', '^NSEI']],
      ['investmentVsBenchmarkTimeline', ['investmentVsBenchmarkTimeline', 'user-1', 'a', 'b', 'c']],
      ['portfolio-composition', ['portfolio-composition', [12345]]],
      ['money-trail', ['money-trail', 'user-1']],
      ['fund-detail', ['fund-detail', 'fund-1']],
      ['portfolio-timeline', ['portfolio-timeline', 'user-1']],
      ['performance-timeline', ['performance-timeline', 'fund-1']],
      ['user-funds', ['user-funds', 'user-1']],
      ['user-transactions', ['user-transactions', 'user-1']],
    ])('%s', (_label, queryKey) => {
      expect(shouldPersistQueryKey(queryKey)).toBe(true);
    });
  });

  describe('does NOT persist', () => {
    it.each([
      ['user-profile (auth-sensitive)', ['user-profile', 'user-1']],
      ['unknown key', ['some-other-thing', 'foo']],
      ['empty key', []],
      ['non-array key', 'not-an-array'],
      ['key starting with non-string', [42, 'foo']],
    ])('%s', (_label, queryKey) => {
      // Cast to any because this fn is intentionally defensive about
      // anything that doesn't match its expected shape.
      expect(shouldPersistQueryKey(queryKey as never)).toBe(false);
    });
  });
});

describe('persister config constants', () => {
  it('exports a 24-hour max age', () => {
    expect(PERSIST_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('exports a non-empty buster string so future bumps invalidate the cache', () => {
    expect(typeof __BUSTER__).toBe('string');
    expect(__BUSTER__.length).toBeGreaterThan(0);
  });
});

describe('STALE_TIMES', () => {
  it('keeps NAV / index history at 6 hours so daily revalidation isn\'t triggered every 5 min', () => {
    expect(STALE_TIMES.NAV_HISTORY).toBe(6 * 60 * 60 * 1000);
    expect(STALE_TIMES.INDEX_HISTORY).toBe(6 * 60 * 60 * 1000);
  });

  it('keeps portfolio aggregates at 1 hour', () => {
    expect(STALE_TIMES.PORTFOLIO).toBe(60 * 60 * 1000);
    expect(STALE_TIMES.PORTFOLIO_COMPOSITION).toBe(60 * 60 * 1000);
    expect(STALE_TIMES.INVESTMENT_VS_BENCHMARK).toBe(60 * 60 * 1000);
    expect(STALE_TIMES.PERFORMANCE_TIMELINE).toBe(60 * 60 * 1000);
    expect(STALE_TIMES.PORTFOLIO_TIMELINE).toBe(60 * 60 * 1000);
  });

  it('keeps user-mutable data (money trail, transactions, profile) at 5 min', () => {
    expect(STALE_TIMES.MONEY_TRAIL).toBe(5 * 60 * 1000);
    expect(STALE_TIMES.USER_TRANSACTIONS).toBe(5 * 60 * 1000);
    expect(STALE_TIMES.USER_PROFILE).toBe(5 * 60 * 1000);
  });
});

describe('queryClient global auth-error handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockedSignOut.mockResolvedValue({ error: null } as Awaited<ReturnType<typeof supabase.auth.signOut>>);
  });

  afterEach(() => {
    // Fast-forward the 5s debounce so `inFlightSignOut` clears between tests.
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    queryClient.clear();
  });

  it('signs the user out and tracks auth_session_invalidated when a query rejects with a 401', async () => {
    await queryClient
      .fetchQuery({
        queryKey: ['unauth'],
        queryFn: () => Promise.reject({ status: 401, message: 'Unauthorized' }),
        retry: false,
      })
      .catch(() => {});

    expect(mockedTrack).toHaveBeenCalledWith('auth_session_invalidated');
    expect(mockedSignOut).toHaveBeenCalledTimes(1);
  });

  it('signs the user out when a query rejects with PostgREST PGRST301 (JWT expired)', async () => {
    await queryClient
      .fetchQuery({
        queryKey: ['jwt-expired'],
        queryFn: () => Promise.reject({ code: 'PGRST301', message: 'JWT expired' }),
        retry: false,
      })
      .catch(() => {});

    expect(mockedSignOut).toHaveBeenCalledTimes(1);
  });

  it('does NOT sign out for unrelated errors (e.g. network 500)', async () => {
    await queryClient
      .fetchQuery({
        queryKey: ['boom'],
        queryFn: () => Promise.reject({ status: 500, message: 'Server error' }),
        retry: false,
      })
      .catch(() => {});

    expect(mockedSignOut).not.toHaveBeenCalled();
    expect(mockedTrack).not.toHaveBeenCalled();
  });

  it('debounces signOut so 50 in-flight 401 errors only sign out once', async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      queryClient
        .fetchQuery({
          queryKey: ['parallel', i],
          queryFn: () => Promise.reject({ status: 401, message: 'Unauthorized' }),
          retry: false,
        })
        .catch(() => {}),
    );

    await Promise.all(promises);
    expect(mockedSignOut).toHaveBeenCalledTimes(1);
  });

  it('signs the user out when a mutation rejects with an auth error', async () => {
    await queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationFn: () => Promise.reject({ status: 401, message: 'Unauthorized' }),
      })
      .execute(undefined)
      .catch(() => {});

    expect(mockedSignOut).toHaveBeenCalledTimes(1);
  });

  it('does not retry queries that fail with an auth error', async () => {
    let attempts = 0;
    await queryClient
      .fetchQuery({
        queryKey: ['no-retry-on-auth'],
        queryFn: () => {
          attempts++;
          return Promise.reject({ status: 401 });
        },
      })
      .catch(() => {});

    expect(attempts).toBe(1);
  });
});
