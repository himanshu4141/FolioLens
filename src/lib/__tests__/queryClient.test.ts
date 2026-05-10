import {
  PERSIST_MAX_AGE_MS,
  __BUSTER__,
  shouldPersistQueryKey,
} from '@/src/lib/queryClient';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

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
