import { normalizeNavigationRoute, type NavigationRouteName } from './navigationPerformance';

export type SyncVisibleRoute =
  | NavigationRouteName
  | 'money_trail'
  | 'portfolio_insights'
  | 'tools';

export interface SyncChangeSummary {
  txInserted: number;
  navInserted: number;
  idxInserted: number;
  txRebuiltFromDrift?: boolean;
}

export interface SyncInvalidationClient {
  invalidateQueries(filters: {
    queryKey: readonly unknown[];
    refetchType: 'none';
  }): Promise<unknown>;
  refetchQueries(filters: {
    queryKey: readonly unknown[];
    type: 'active';
  }): Promise<unknown>;
}

export const SYNC_INVALIDATION_PREFIXES = {
  transaction: [
    'user-funds',
    'user-transactions',
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
  ],
  nav: [
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
  ],
  index: [
    'portfolio',
    'fund-detail-index',
    'index-snapshot',
    'investmentVsBenchmarkTimeline',
    'portfolioTimeline',
    'performance-timeline',
    'past-sip-check:benchmark',
  ],
} as const;

const VISIBLE_ROUTE_PREFIXES: Record<SyncVisibleRoute, readonly string[]> = {
  portfolio: [
    'user-funds',
    'portfolio',
    'investmentVsBenchmarkTimeline',
    'portfolioTimeline',
    'money-trail',
  ],
  funds: ['portfolio'],
  wealth_journey: ['portfolio', 'wealth-journey-transactions'],
  settings: ['latest-nav-date'],
  about: [],
  fund_detail: [
    'fund-detail',
    'fund-nav-history',
    'fund-detail-index',
    'investmentVsBenchmarkTimeline',
    'performance-timeline',
  ],
  money_trail: ['money-trail'],
  portfolio_insights: ['portfolio'],
  tools: [
    'dvr-funds',
    'past-sip-check:user-held-seed',
    'universal-picker:your-funds',
    'universal-picker:your-families',
    'fund-nav-history-compare',
    'compare:navhistory',
    'past-sip-check:fund-nav',
    'past-sip-check:benchmark',
  ],
  unknown: [],
};

export function syncVisibleRoute(pathname: string): SyncVisibleRoute {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (path === '/money-trail' || path.startsWith('/money-trail/')) return 'money_trail';
  if (path === '/portfolio-insights') return 'portfolio_insights';
  if (path === '/tools' || path.startsWith('/tools/')) return 'tools';
  if (
    (path.startsWith('/settings/') || path.startsWith('/(tabs)/settings/')) &&
    path !== '/settings/about' &&
    path !== '/(tabs)/settings/about'
  ) return 'settings';
  return normalizeNavigationRoute(pathname);
}

export function syncInvalidationPrefixes(result: SyncChangeSummary): readonly string[] {
  const prefixes = new Set<string>();
  const transactionChanged = result.txInserted > 0 || result.txRebuiltFromDrift === true;

  if (transactionChanged) {
    for (const prefix of SYNC_INVALIDATION_PREFIXES.transaction) prefixes.add(prefix);
  }
  if (result.navInserted > 0) {
    for (const prefix of SYNC_INVALIDATION_PREFIXES.nav) prefixes.add(prefix);
  }
  if (result.idxInserted > 0) {
    for (const prefix of SYNC_INVALIDATION_PREFIXES.index) prefixes.add(prefix);
  }

  return [...prefixes];
}

/**
 * Mark every affected derived query stale without waking hidden observers,
 * then refetch only affected active queries owned by the visible route.
 */
export async function invalidateQueriesForSync(
  client: SyncInvalidationClient,
  result: SyncChangeSummary,
  visibleRoute: SyncVisibleRoute,
): Promise<void> {
  const prefixes = syncInvalidationPrefixes(result);
  if (prefixes.length === 0) return;

  await Promise.all(prefixes.map((prefix) => client.invalidateQueries({
    queryKey: [prefix],
    refetchType: 'none',
  })));

  const affected = new Set(prefixes);
  const visiblePrefixes = VISIBLE_ROUTE_PREFIXES[visibleRoute].filter((prefix) => affected.has(prefix));
  await Promise.all(visiblePrefixes.map((prefix) => client.refetchQueries({
    queryKey: [prefix],
    type: 'active',
  })));
}
