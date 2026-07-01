import { analytics } from '@/src/lib/analytics';
import {
  perfCancel,
  perfEnd,
  perfStart,
  type PerfSpanId,
} from '@/src/lib/perfMark';
import { isSyncInFlight } from '@/src/lib/performanceRuntimeState';

export type NavigationRouteName =
  | 'portfolio'
  | 'funds'
  | 'wealth_journey'
  | 'settings'
  | 'about'
  | 'fund_detail'
  | 'unknown';

export type NavigationTransition =
  | 'portfolio_to_settings'
  | 'settings_to_about'
  | 'fund_detail'
  | 'bottom_tab';

export type NavigationMetricPhase = 'route_commit' | 'post_interaction_usable';
export type NavigationCacheState = 'warm' | 'cold' | 'unknown';

export interface NavigationMetricContext {
  cache_state?: NavigationCacheState;
  active_query_count?: number;
  fund_count?: number;
  transaction_count?: number;
  nav_row_count?: number;
}

export interface NavigationMeasurementInput {
  transition: NavigationTransition;
  fromRoute: NavigationRouteName;
  toRoute: NavigationRouteName;
  context?: NavigationMetricContext;
}

export interface NavigationQueryCacheReader {
  getQueryData(queryKey: readonly unknown[]): unknown;
  getQueriesData(filters: { queryKey: readonly unknown[] }): [readonly unknown[], unknown][];
  getQueryCache?(): {
    findAll(): { getObserversCount(): number }[];
  };
}

export interface NavigationCacheContextOptions {
  toRoute: NavigationRouteName;
  targetQueryKey?: readonly unknown[];
  fundCount?: number;
}

interface PendingNavigation {
  id: string;
  startedAt: number;
  transition: NavigationTransition;
  fromRoute: NavigationRouteName;
  toRoute: NavigationRouteName;
  context: Record<string, unknown>;
  commitSpanId: PerfSpanId;
  usableSpanId: PerfSpanId;
  committed: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_COUNT = 1_000_000;
const pendingNavigations = new Map<string, PendingNavigation>();
let nextNavigationId = 0;

const ROUTES = new Set<NavigationRouteName>([
  'portfolio',
  'funds',
  'wealth_journey',
  'settings',
  'about',
  'fund_detail',
  'unknown',
]);
const TRANSITIONS = new Set<NavigationTransition>([
  'portfolio_to_settings',
  'settings_to_about',
  'fund_detail',
  'bottom_tab',
]);
const PHASES = new Set<NavigationMetricPhase>(['route_commit', 'post_interaction_usable']);
const CACHE_STATES = new Set<NavigationCacheState>(['warm', 'cold', 'unknown']);
const TAB_ROUTES = new Set<NavigationRouteName>(['portfolio', 'funds', 'wealth_journey']);

/** Map dynamic Expo Router paths to a fixed, low-cardinality vocabulary. */
export function normalizeNavigationRoute(pathname: string): NavigationRouteName {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/(tabs)' || path === '/(tabs)/index') return 'portfolio';
  if (path === '/funds' || path === '/(tabs)/funds') return 'funds';
  if (path === '/wealth-journey' || path === '/(tabs)/wealth-journey') return 'wealth_journey';
  if (path === '/settings' || path === '/(tabs)/settings') return 'settings';
  if (path === '/settings/about' || path === '/(tabs)/settings/about') return 'about';
  if (/^\/fund\/[^/]+$/.test(path)) return 'fund_detail';
  return 'unknown';
}

/**
 * Strict analytics allowlist. Unknown keys and malformed values are discarded,
 * so callers cannot accidentally attach a fund ID, pathname, name, or user data.
 */
export function sanitizeNavigationMetric(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  if (typeof input.transition === 'string' && TRANSITIONS.has(input.transition as NavigationTransition)) {
    output.transition = input.transition;
  }
  if (typeof input.from_route === 'string' && ROUTES.has(input.from_route as NavigationRouteName)) {
    output.from_route = input.from_route;
  }
  if (typeof input.to_route === 'string' && ROUTES.has(input.to_route as NavigationRouteName)) {
    output.to_route = input.to_route;
  }
  if (typeof input.phase === 'string' && PHASES.has(input.phase as NavigationMetricPhase)) {
    output.phase = input.phase;
  }
  if (typeof input.cache_state === 'string' && CACHE_STATES.has(input.cache_state as NavigationCacheState)) {
    output.cache_state = input.cache_state;
  }
  if (typeof input.sync_in_flight === 'boolean') {
    output.sync_in_flight = input.sync_in_flight;
  }

  for (const key of ['active_query_count', 'fund_count', 'transaction_count', 'nav_row_count', 'elapsed_ms'] as const) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      output[key] = Math.min(Math.round(value), MAX_COUNT);
    }
  }

  return output;
}

/** Read existing React Query state only; this helper never fetches or prefetches. */
export function getNavigationCacheContext(
  queryCache: NavigationQueryCacheReader,
  options: NavigationCacheContextOptions,
): NavigationMetricContext {
  const context: NavigationMetricContext = {};
  const cachedFunds = firstArrayLength(queryCache, ['user-funds']);
  const cachedTransactions = firstArrayLength(queryCache, ['user-transactions']);
  const allQueries = queryCache.getQueryCache?.().findAll() ?? [];

  context.active_query_count = allQueries.filter((query) => query.getObserversCount() > 0).length;

  if (cachedFunds !== undefined || options.fundCount !== undefined) {
    context.fund_count = cachedFunds ?? options.fundCount;
  }
  if (cachedTransactions !== undefined) {
    context.transaction_count = cachedTransactions;
  }

  if (options.targetQueryKey) {
    context.cache_state = queryCache.getQueryData(options.targetQueryKey) === undefined ? 'cold' : 'warm';
    return context;
  }

  const targetPrefix = queryPrefixForRoute(options.toRoute);
  if (!targetPrefix) {
    context.cache_state = 'unknown';
    return context;
  }
  const targetEntries = queryCache.getQueriesData({ queryKey: targetPrefix });
  context.cache_state = targetEntries.some(([, data]) => data !== undefined) ? 'warm' : 'cold';
  if (options.toRoute === 'settings' && context.cache_state === 'warm') {
    context.nav_row_count = 1;
  }
  return context;
}

export function startNavigationMeasurement(input: NavigationMeasurementInput): string | null {
  cleanupExpiredNavigations();
  if (!isSupportedTransition(input) || input.fromRoute === input.toRoute) return null;

  nextNavigationId += 1;
  const id = `nav-${nextNavigationId}`;
  const context = sanitizeNavigationMetric({
    transition: input.transition,
    from_route: input.fromRoute,
    to_route: input.toRoute,
    cache_state: input.context?.cache_state ?? 'unknown',
    sync_in_flight: isSyncInFlight(),
    active_query_count: input.context?.active_query_count,
    fund_count: input.context?.fund_count,
    transaction_count: input.context?.transaction_count,
    nav_row_count: input.context?.nav_row_count,
  });

  const navigation: PendingNavigation = {
    id,
    startedAt: Date.now(),
    transition: input.transition,
    fromRoute: input.fromRoute,
    toRoute: input.toRoute,
    context,
    commitSpanId: perfStart('navigation:press_to_route_commit'),
    usableSpanId: perfStart('navigation:press_to_post_interaction_usable'),
    committed: false,
    timeout: setTimeout(() => cancelNavigationMeasurement(id), NAVIGATION_TIMEOUT_MS),
  };
  pendingNavigations.set(id, navigation);
  return id;
}

/** Close commit spans for every compatible pending press and return their IDs. */
export function markNavigationRouteCommitted(pathname: string): string[] {
  cleanupExpiredNavigations();
  const route = normalizeNavigationRoute(pathname);
  if (route === 'unknown') return [];

  const committedIds: string[] = [];
  for (const navigation of [...pendingNavigations.values()]) {
    if (navigation.committed) continue;
    if (navigation.toRoute !== route) {
      cancelNavigationMeasurement(navigation.id);
      continue;
    }
    navigation.committed = true;
    completeNavigationPhase(navigation, 'route_commit', navigation.commitSpanId);
    committedIds.push(navigation.id);
  }
  return committedIds;
}

export function markNavigationUsable(navigationId: string): void {
  const navigation = pendingNavigations.get(navigationId);
  if (!navigation || !navigation.committed) return;
  completeNavigationPhase(navigation, 'post_interaction_usable', navigation.usableSpanId);
  clearTimeout(navigation.timeout);
  pendingNavigations.delete(navigationId);
}

export function cancelNavigationMeasurement(navigationId: string): void {
  const navigation = pendingNavigations.get(navigationId);
  if (!navigation) return;
  perfCancel(navigation.commitSpanId);
  perfCancel(navigation.usableSpanId);
  clearTimeout(navigation.timeout);
  pendingNavigations.delete(navigationId);
}

export function cancelAllNavigationMeasurements(): void {
  for (const navigationId of [...pendingNavigations.keys()]) {
    cancelNavigationMeasurement(navigationId);
  }
}

function completeNavigationPhase(
  navigation: PendingNavigation,
  phase: NavigationMetricPhase,
  spanId: PerfSpanId,
): void {
  const properties = sanitizeNavigationMetric({ ...navigation.context, phase });
  const elapsedMs = perfEnd(spanId, properties);
  if (elapsedMs < 0) return;
  analytics.track('navigation_performance', sanitizeNavigationMetric({
    ...properties,
    elapsed_ms: elapsedMs,
  }));
}

function cleanupExpiredNavigations(now = Date.now()): void {
  for (const navigation of pendingNavigations.values()) {
    if (now - navigation.startedAt > NAVIGATION_TIMEOUT_MS) {
      cancelNavigationMeasurement(navigation.id);
    }
  }
}

function isSupportedTransition(input: NavigationMeasurementInput): boolean {
  switch (input.transition) {
    case 'portfolio_to_settings':
      return input.fromRoute === 'portfolio' && input.toRoute === 'settings';
    case 'settings_to_about':
      return input.fromRoute === 'settings' && input.toRoute === 'about';
    case 'fund_detail':
      return (input.fromRoute === 'portfolio' || input.fromRoute === 'funds') && input.toRoute === 'fund_detail';
    case 'bottom_tab':
      return TAB_ROUTES.has(input.fromRoute) && TAB_ROUTES.has(input.toRoute);
  }
}

function queryPrefixForRoute(route: NavigationRouteName): readonly unknown[] | null {
  switch (route) {
    case 'portfolio':
    case 'funds':
      return ['portfolio'];
    case 'wealth_journey':
      return ['wealth-journey-transactions'];
    case 'settings':
      return ['latest-nav-date'];
    default:
      return null;
  }
}

function firstArrayLength(
  queryCache: NavigationQueryCacheReader,
  queryKey: readonly unknown[],
): number | undefined {
  for (const [, data] of queryCache.getQueriesData({ queryKey })) {
    if (Array.isArray(data)) return data.length;
  }
  return undefined;
}
