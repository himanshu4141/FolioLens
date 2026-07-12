jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    getAllKeys: jest.fn().mockResolvedValue([]),
    multiRemove: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/src/lib/auth', () => ({
  authClient: { signOut: jest.fn() },
}));

jest.mock('@/src/lib/analytics', () => ({
  analytics: { track: jest.fn() },
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import {
  PERSIST_MAX_AGE_MS,
  PERSIST_SAFE_MAX_CHARS,
  __BUSTER__,
  estimatePersistedBlobBytes,
  queryClient,
  retryPersistedClient,
  shouldPersistQueryKey,
  summarizePersistedClient,
} from '@/src/lib/queryClient';
// eslint-disable-next-line import/first
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
// eslint-disable-next-line import/first
import { authClient } from '@/src/lib/auth';
// eslint-disable-next-line import/first
import { analytics } from '@/src/lib/analytics';
// eslint-disable-next-line import/first
import { Platform } from 'react-native';

const mockedSignOut = authClient.signOut as jest.MockedFunction<typeof authClient.signOut>;
const mockedTrack = analytics.track as jest.MockedFunction<typeof analytics.track>;

describe('shouldPersistQueryKey()', () => {
  describe('persists', () => {
    it.each([
      ['portfolio aggregate', ['portfolio', 'user-1', '^NSEI']],
      ['investmentVsBenchmarkTimeline', ['investmentVsBenchmarkTimeline', 'user-1', 'a', 'b', 'c']],
      ['portfolio-composition', ['portfolio-composition', [12345]]],
      ['money-trail', ['money-trail', 'user-1']],
      ['user-funds', ['user-funds', 'user-1']],
    ])('%s', (_label, queryKey) => {
      expect(shouldPersistQueryKey(queryKey)).toBe(true);
    });

    it('persists web user-transactions because web has no SQLite read-through', () => {
      const originalOS = Platform.OS;
      Platform.OS = 'web';

      try {
        expect(shouldPersistQueryKey(['user-transactions', 'user-1'])).toBe(true);
      } finally {
        Platform.OS = originalOS;
      }
    });
  });

  describe('does NOT persist', () => {
    it.each([
      ['user-profile (auth-sensitive)', ['user-profile', 'user-1']],
      ['native user-transactions raw array (authoritative copy is SQLite)', ['user-transactions', 'user-1']],
      ['prepared investment timeline input (user-scoped Maps)', ['investmentTimelineInputs', 'user-1', 'fund-1:100', '3Y']],
      ['raw fund NAV history (authoritative copy is SQLite)', ['fund-nav-history', 12345]],
      ['raw performance history (authoritative copy is SQLite)', ['performance-timeline', 'fund-1']],
      ['raw index snapshot (authoritative copy is SQLite/CDN)', ['index-snapshot', '^NSEI']],
      ['fund detail embeds raw NAV history', ['fund-detail', 'fund-1']],
      ['fund detail index embeds raw index history', ['fund-detail-index', '^NSEI']],
      ['legacy portfolio timeline', ['portfolio-timeline', 'user-1']],
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
  it('exports a 48-hour max age', () => {
    expect(PERSIST_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('exports a non-empty buster string so future bumps invalidate the cache', () => {
    expect(typeof __BUSTER__).toBe('string');
    expect(__BUSTER__.length).toBeGreaterThan(0);
  });

  it('leaves at least 2 MB of the Android 6 MB AsyncStorage database for non-query state', () => {
    expect(PERSIST_SAFE_MAX_CHARS).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('summarizePersistedClient()', () => {
  it('estimates persisted blob bytes using web localStorage UTF-16 semantics', () => {
    expect(estimatePersistedBlobBytes(2_400_000, 'web')).toBe(4_800_000);
    expect(estimatePersistedBlobBytes(2_400_000, 'ios')).toBe(2_400_000);
    expect(estimatePersistedBlobBytes(-1, 'web')).toBe(0);
  });

  it('reports total size, query count, and per-prefix serialized bytes', () => {
    const stateFor = (data: string) => ({
      data,
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: 'success' as const,
      fetchStatus: 'idle' as const,
    });
    const firstPortfolio = {
      dehydratedAt: 1,
      state: stateFor('x'.repeat(20)),
      queryKey: ['portfolio', 'user-1'],
      queryHash: '["portfolio","user-1"]',
    };
    const secondPortfolio = {
      dehydratedAt: 1,
      state: stateFor('y'.repeat(10)),
      queryKey: ['portfolio', 'user-1', '^NSEI'],
      queryHash: '["portfolio","user-1","^NSEI"]',
    };
    const moneyTrail = {
      dehydratedAt: 1,
      state: stateFor('z'.repeat(100)),
      queryKey: ['money-trail', 'user-1'],
      queryHash: '["money-trail","user-1"]',
    };
    const client = {
      buster: 'v11',
      timestamp: 1,
      clientState: { mutations: [], queries: [firstPortfolio, secondPortfolio, moneyTrail] },
    };

    const metrics = summarizePersistedClient(client);

    expect(metrics.serializedChars).toBe(JSON.stringify(client).length);
    expect(metrics.queryCount).toBe(3);
    expect(metrics.byKeyPrefix).toEqual([
      {
        prefix: 'portfolio',
        count: 2,
        serializedChars: JSON.stringify(firstPortfolio).length + JSON.stringify(secondPortfolio).length,
      },
      {
        prefix: 'money-trail',
        count: 1,
        serializedChars: JSON.stringify(moneyTrail).length,
      },
    ]);
  });
});

describe('retryPersistedClient()', () => {
  const makeQuery = (family: string, payload: string) => ({
    dehydratedAt: 1,
    state: { data: payload, dataUpdateCount: 1, dataUpdatedAt: 1, error: null, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, status: 'success' as const, fetchStatus: 'idle' as const },
    queryKey: [family],
    queryHash: `[\"${family}\"]`,
  });

  it('drops the largest query and preserves mutations and the remaining queries', () => {
    const small = makeQuery('portfolio', 'small');
    const large = makeQuery('money-trail', 'x'.repeat(1000));
    const client = {
      buster: 'v10',
      timestamp: 1,
      clientState: { mutations: [], queries: [small, large] },
    };

    const retried = retryPersistedClient(client, new Error('database is full'), 1);

    expect(retried?.clientState.queries).toEqual([small]);
    expect(retried?.clientState.mutations).toEqual([]);
    expect(mockedTrack).toHaveBeenCalledWith(
      'persister_write_retried',
      expect.objectContaining({
        removed_query_family: 'money-trail',
        remaining_query_count: 1,
      }),
    );
  });

  it('stops retrying when no queries remain', () => {
    const client = {
      buster: 'v10',
      timestamp: 1,
      clientState: { mutations: [], queries: [] },
    };

    expect(retryPersistedClient(client, new Error('database is full'), 2)).toBeUndefined();
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
    mockedSignOut.mockResolvedValue({ error: null } as Awaited<ReturnType<typeof authClient.signOut>>);
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
