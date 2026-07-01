import { analytics } from '@/src/lib/analytics';
import {
  cancelAllNavigationMeasurements,
  getNavigationCacheContext,
  markNavigationRouteCommitted,
  markNavigationUsable,
  normalizeNavigationRoute,
  sanitizeNavigationMetric,
  startNavigationMeasurement,
} from '@/src/lib/navigationPerformance';
import { beginSyncActivity } from '@/src/lib/performanceRuntimeState';

jest.mock('@/src/lib/analytics', () => ({
  analytics: {
    isEnabled: true,
    track: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
    captureException: jest.fn(),
  },
}));

const mockTrack = analytics.track as jest.MockedFunction<typeof analytics.track>;

describe('navigationPerformance', () => {
  const originalWarn = console.warn;

  beforeEach(() => {
    mockTrack.mockReset();
    console.warn = jest.fn();
  });

  afterEach(() => {
    cancelAllNavigationMeasurements();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    console.warn = originalWarn;
  });

  it('normalizes dynamic routes without retaining identifiers', () => {
    expect(normalizeNavigationRoute('/')).toBe('portfolio');
    expect(normalizeNavigationRoute('/(tabs)/funds?sort=xirr')).toBe('funds');
    expect(normalizeNavigationRoute('/settings/about/')).toBe('about');
    expect(normalizeNavigationRoute('/fund/private-fund-id')).toBe('fund_detail');
    expect(normalizeNavigationRoute('/money-trail/private-transaction-id')).toBe('unknown');
  });

  it('allows only bounded low-cardinality navigation properties', () => {
    expect(sanitizeNavigationMetric({
      transition: 'fund_detail',
      from_route: 'funds',
      to_route: 'fund_detail',
      phase: 'route_commit',
      cache_state: 'warm',
      sync_in_flight: true,
      active_query_count: 9,
      fund_count: 12.4,
      transaction_count: 5_000_000,
      nav_row_count: -1,
      elapsed_ms: Number.NaN,
      fund_id: 'private-fund-id',
      fund_name: 'Private Fund Name',
      user_id: 'private-user-id',
      pathname: '/fund/private-fund-id',
      details: { transaction: 'private' },
    })).toEqual({
      transition: 'fund_detail',
      from_route: 'funds',
      to_route: 'fund_detail',
      phase: 'route_commit',
      cache_state: 'warm',
      sync_in_flight: true,
      active_query_count: 9,
      fund_count: 12,
      transaction_count: 1_000_000,
    });
  });

  it('reads cache warmth and aggregate row counts without fetching', () => {
    const getQueryData = jest.fn((key: readonly unknown[]) => (
      key[0] === 'fund-detail' && key[1] === 'local-only-id' ? { ready: true } : undefined
    ));
    const getQueriesData = jest.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
      if (queryKey[0] === 'user-funds') {
        return [[['user-funds', 'private-user'], Array.from({ length: 7 })] as [readonly unknown[], unknown]];
      }
      if (queryKey[0] === 'user-transactions') {
        return [[['user-transactions', 'private-user'], Array.from({ length: 550 })] as [readonly unknown[], unknown]];
      }
      return [];
    });
    const getQueryCache = jest.fn(() => ({
      findAll: () => [
        { getObserversCount: () => 2 },
        { getObserversCount: () => 0 },
        { getObserversCount: () => 1 },
      ],
    }));

    expect(getNavigationCacheContext(
      { getQueryData, getQueriesData, getQueryCache },
      { toRoute: 'fund_detail', targetQueryKey: ['fund-detail', 'local-only-id'] },
    )).toEqual({
      active_query_count: 2,
      cache_state: 'warm',
      fund_count: 7,
      transaction_count: 550,
    });
    expect(getQueryData).toHaveBeenCalledTimes(1);
  });

  it('completes overlapping presses independently with sanitized analytics', () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const finishSyncActivity = beginSyncActivity();

    const first = startNavigationMeasurement({
      transition: 'fund_detail',
      fromRoute: 'funds',
      toRoute: 'fund_detail',
      context: { cache_state: 'cold', fund_count: 5 },
    });
    now = 1_010;
    const second = startNavigationMeasurement({
      transition: 'fund_detail',
      fromRoute: 'funds',
      toRoute: 'fund_detail',
      context: { cache_state: 'warm', fund_count: 5 },
    });
    now = 1_050;

    const committed = markNavigationRouteCommitted('/fund/private-fund-id');
    expect(committed).toEqual([first, second]);
    now = 1_100;
    for (const id of committed) markNavigationUsable(id);
    finishSyncActivity();

    const navigationEvents = mockTrack.mock.calls.filter(([event]) => event === 'navigation_performance');
    expect(navigationEvents).toHaveLength(4);
    expect(navigationEvents[0][1]).toEqual(expect.objectContaining({
      transition: 'fund_detail',
      from_route: 'funds',
      to_route: 'fund_detail',
      phase: 'route_commit',
      sync_in_flight: true,
      elapsed_ms: 50,
    }));
    expect(navigationEvents[1][1]).toEqual(expect.objectContaining({
      phase: 'route_commit',
      elapsed_ms: 40,
    }));
    expect(navigationEvents.flatMap(([, properties]) => Object.keys(properties ?? {}))).not.toEqual(
      expect.arrayContaining(['fund_id', 'fund_name', 'user_id', 'pathname']),
    );
  });

  it('ignores unsupported route-pair combinations', () => {
    expect(startNavigationMeasurement({
      transition: 'settings_to_about',
      fromRoute: 'funds',
      toRoute: 'about',
    })).toBeNull();
  });

  it('expires an abandoned navigation without emitting a metric', () => {
    jest.useFakeTimers();
    expect(startNavigationMeasurement({
      transition: 'settings_to_about',
      fromRoute: 'settings',
      toRoute: 'about',
    })).not.toBeNull();

    jest.advanceTimersByTime(30_001);

    expect(markNavigationRouteCommitted('/settings/about')).toEqual([]);
    expect(mockTrack).not.toHaveBeenCalledWith('navigation_performance', expect.anything());
  });

  it('cancels an unmatched press when a different route commits', () => {
    expect(startNavigationMeasurement({
      transition: 'settings_to_about',
      fromRoute: 'settings',
      toRoute: 'about',
    })).not.toBeNull();

    expect(markNavigationRouteCommitted('/funds')).toEqual([]);
    expect(markNavigationRouteCommitted('/settings/about')).toEqual([]);
    expect(mockTrack).not.toHaveBeenCalledWith('navigation_performance', expect.anything());
  });
});
