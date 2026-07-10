import {
  invalidateQueriesForSync,
  syncInvalidationPrefixes,
  syncVisibleRoute,
  type SyncChangeSummary,
  type SyncInvalidationClient,
} from '@/src/lib/syncInvalidation';

const EMPTY_RESULT: SyncChangeSummary = {
  txInserted: 0,
  navInserted: 0,
  idxInserted: 0,
};

function prefixNames(prefixes: readonly string[]): Set<string> {
  return new Set(prefixes);
}

function createClient() {
  const invalidateQueries = jest.fn(async (
    _filters: Parameters<SyncInvalidationClient['invalidateQueries']>[0],
  ) => {});
  const refetchQueries = jest.fn(async (
    _filters: Parameters<SyncInvalidationClient['refetchQueries']>[0],
  ) => {});
  const client: SyncInvalidationClient = { invalidateQueries, refetchQueries };
  return { client, invalidateQueries, refetchQueries };
}

describe('syncInvalidationPrefixes', () => {
  it('does nothing when sync changed no rows', () => {
    expect(syncInvalidationPrefixes(EMPTY_RESULT)).toEqual([]);
  });

  it('keeps NAV-only sync away from Money Trail and transaction derivations', () => {
    const prefixes = prefixNames(syncInvalidationPrefixes({
      ...EMPTY_RESULT,
      navInserted: 1,
    }));

    expect(prefixes).toEqual(new Set([
      'portfolio-core',
      'portfolio',
      'fund-detail',
      'fund-nav-history',
      'latest-nav-date',
      'investmentTimelineInputs',
      'investmentVsBenchmarkTimeline',
      'portfolioTimeline',
      'performance-timeline',
      'dvr-funds',
      'fund-nav-history-compare',
      'compare:navhistory',
      'past-sip-check:fund-nav',
    ]));
    expect(prefixes).not.toContain('money-trail');
    expect(prefixes).not.toContain('user-transactions');
    expect(prefixes).not.toContain('wealth-journey-transactions');
  });

  it('invalidates every transaction-derived summary and the CAS fund roster', () => {
    const prefixes = prefixNames(syncInvalidationPrefixes({
      ...EMPTY_RESULT,
      txInserted: 1,
    }));

    expect(prefixes).toEqual(new Set([
      'user-funds',
      'user-transactions',
      'portfolio-core',
      'portfolio-benchmark',
      'portfolio',
      'fund-detail',
      'money-trail',
      'investmentTimelineInputs',
      'investmentVsBenchmarkTimeline',
      'portfolioTimeline',
      'performance-timeline',
      'wealth-journey-transactions',
      'dvr-funds',
      'past-sip-check:user-held-seed',
      'universal-picker:your-funds',
      'universal-picker:your-families',
    ]));
  });

  it('treats a drift rebuild as a transaction change', () => {
    const prefixes = prefixNames(syncInvalidationPrefixes({
      ...EMPTY_RESULT,
      txRebuiltFromDrift: true,
    }));

    expect(prefixes).toContain('user-transactions');
    expect(prefixes).toContain('portfolio');
    expect(prefixes).toContain('money-trail');
  });

  it('keeps index-only sync scoped to benchmark-derived queries', () => {
    const prefixes = prefixNames(syncInvalidationPrefixes({
      ...EMPTY_RESULT,
      idxInserted: 1,
    }));

    expect(prefixes).toEqual(new Set([
      'portfolio-benchmark',
      'portfolio',
      'fund-detail-index',
      'index-snapshot',
      'investmentVsBenchmarkTimeline',
      'portfolioTimeline',
      'performance-timeline',
      'past-sip-check:benchmark',
    ]));
    expect(prefixes).not.toContain('user-transactions');
    expect(prefixes).not.toContain('money-trail');
    expect(prefixes).not.toContain('fund-nav-history');
  });
});

describe('syncVisibleRoute', () => {
  it.each([
    ['/money-trail', 'money_trail'],
    ['/money-trail/transaction-1', 'money_trail'],
    ['/portfolio-insights', 'portfolio_insights'],
    ['/tools', 'tools'],
    ['/tools/compare-funds', 'tools'],
    ['/tools/direct-vs-regular', 'tools'],
    ['/tools/past-sip-check', 'tools'],
    ['/settings/data-sync', 'settings'],
    ['/settings/about', 'about'],
    ['/(tabs)/funds', 'funds'],
  ])('maps %s to %s', (pathname, expected) => {
    expect(syncVisibleRoute(pathname)).toBe(expected);
  });
});

describe('invalidateQueriesForSync', () => {
  it('marks all affected entries stale without refetching hidden screens', async () => {
    const { client, invalidateQueries, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, {
      txInserted: 1,
      navInserted: 1,
      idxInserted: 1,
    }, 'about');

    expect(invalidateQueries).toHaveBeenCalled();
    for (const [filters] of invalidateQueries.mock.calls) {
      expect(filters.refetchType).toBe('none');
    }
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('refetches only affected active queries owned by visible Portfolio', async () => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, {
      ...EMPTY_RESULT,
      idxInserted: 1,
    }, 'portfolio');

    expect(refetchQueries.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['portfolio'], type: 'active' },
      { queryKey: ['investmentVsBenchmarkTimeline'], type: 'active' },
      { queryKey: ['portfolioTimeline'], type: 'active' },
    ]);
  });

  it('immediately refreshes the visible Portfolio CAS roster after transaction sync', async () => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, {
      ...EMPTY_RESULT,
      txInserted: 1,
    }, 'portfolio');

    expect(refetchQueries.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['user-funds'], type: 'active' },
      { queryKey: ['portfolio'], type: 'active' },
      { queryKey: ['investmentVsBenchmarkTimeline'], type: 'active' },
      { queryKey: ['portfolioTimeline'], type: 'active' },
      { queryKey: ['money-trail'], type: 'active' },
    ]);
  });

  it('refetches Wealth Journey transaction inputs but not hidden Money Trail', async () => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, {
      ...EMPTY_RESULT,
      txInserted: 2,
    }, 'wealth_journey');

    expect(refetchQueries.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['portfolio'], type: 'active' },
      { queryKey: ['wealth-journey-transactions'], type: 'active' },
    ]);
  });

  it('refetches visible Money Trail after transaction sync', async () => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, {
      ...EMPTY_RESULT,
      txInserted: 1,
    }, 'money_trail');

    expect(refetchQueries).toHaveBeenCalledWith({
      queryKey: ['money-trail'],
      type: 'active',
    });
  });

  it.each([
    [
      { ...EMPTY_RESULT, txInserted: 1 },
      [
        'dvr-funds',
        'past-sip-check:user-held-seed',
        'universal-picker:your-funds',
        'universal-picker:your-families',
      ],
    ],
    [
      { ...EMPTY_RESULT, navInserted: 1 },
      [
        'dvr-funds',
        'fund-nav-history-compare',
        'compare:navhistory',
        'past-sip-check:fund-nav',
      ],
    ],
    [
      { ...EMPTY_RESULT, idxInserted: 1 },
      ['past-sip-check:benchmark'],
    ],
  ] as const)('refetches affected active tool prefixes for %j', async (result, expected) => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, result, 'tools');

    expect(refetchQueries.mock.calls.map(([filters]) => filters.queryKey[0])).toEqual(expected);
  });

  it.each([
    ['funds', { ...EMPTY_RESULT, navInserted: 1 }, ['portfolio']],
    ['settings', { ...EMPTY_RESULT, navInserted: 1 }, ['latest-nav-date']],
    [
      'fund_detail',
      { txInserted: 1, navInserted: 1, idxInserted: 1 },
      [
        'fund-detail',
        'fund-nav-history',
        'fund-detail-index',
        'investmentVsBenchmarkTimeline',
        'performance-timeline',
      ],
    ],
  ] as const)('refetches only affected %s-owned prefixes', async (route, result, expected) => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, result, route);

    expect(refetchQueries.mock.calls.map(([filters]) => filters.queryKey[0])).toEqual(expected);
  });

  it('does not refetch any prefix for an unknown route', async () => {
    const { client, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, {
      txInserted: 1,
      navInserted: 1,
      idxInserted: 1,
    }, 'unknown');

    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('does not touch the client for error-only/no-change results', async () => {
    const { client, invalidateQueries, refetchQueries } = createClient();
    await invalidateQueriesForSync(client, EMPTY_RESULT, 'portfolio');

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(refetchQueries).not.toHaveBeenCalled();
  });
});
