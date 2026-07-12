import { analytics } from '@/src/lib/analytics';

export type UxSurface =
  | 'app'
  | 'auth'
  | 'onboarding'
  | 'portfolio'
  | 'funds'
  | 'fund_detail'
  | 'money_trail'
  | 'settings'
  | 'about'
  | 'wealth_journey'
  | 'tools'
  | 'unknown';

export type UxReadiness = 'route_painted' | 'content_ready';
export type UxCacheState =
  | 'warm'
  | 'cold'
  | 'restored'
  | 'network'
  | 'sqlite'
  | 'mixed'
  | 'empty'
  | 'unknown';
export type UxMetric = 'elapsed_ms' | 'stall_ms' | 'blob_size_bytes';
export type UxSourceEvent =
  | 'ux_screen_ready'
  | 'ux_interaction_latency'
  | 'ux_js_stall'
  | 'ux_cache_health'
  | 'navigation_performance'
  | 'perf_mark';

export interface UxTelemetryContext {
  platform?: string | null;
  app_version?: string | null;
  eas_update_id?: string | null;
  eas_update_created_at?: string | null;
  is_embedded_launch?: boolean | null;
}

interface UxScreenReadyInput {
  surface: UxSurface;
  readiness: UxReadiness;
  elapsedMs: number;
  coldStart?: boolean;
  cacheState?: UxCacheState;
  rowCount?: number | null;
  fundCount?: number | null;
  transactionCount?: number | null;
}

interface UxInteractionLatencyInput {
  surface: UxSurface;
  action: string;
  elapsedMs: number;
  cacheState?: UxCacheState;
  rowCount?: number | null;
  fundCount?: number | null;
  transactionCount?: number | null;
}

interface UxJsStallInput {
  surface: UxSurface;
  stallMs: number;
}

interface UxCacheHealthInput {
  cacheState: UxCacheState;
  blobSizeBytes?: number | null;
  queryCount?: number | null;
  buster?: string | null;
}

interface UxSlowEventInput {
  sourceEvent: UxSourceEvent;
  surface: UxSurface;
  metric: UxMetric;
  valueMs?: number;
  valueBytes?: number;
  threshold: number;
  readiness?: UxReadiness;
  action?: string;
  cacheState?: UxCacheState;
}

const MAX_SAFE_METRIC = 1_000_000;
const MAX_SAFE_BYTES = 50_000_000;
const MAX_ACTION_LENGTH = 64;

export const UX_THRESHOLDS = {
  routePaintMs: 750,
  contentReadyMs: 1_500,
  interactionMs: 500,
  jsStallMs: 250,
  cacheBlobBytes: 5_000_000,
} as const;

const SURFACES = new Set<UxSurface>([
  'app',
  'auth',
  'onboarding',
  'portfolio',
  'funds',
  'fund_detail',
  'money_trail',
  'settings',
  'about',
  'wealth_journey',
  'tools',
  'unknown',
]);
const READINESS = new Set<UxReadiness>(['route_painted', 'content_ready']);
const CACHE_STATES = new Set<UxCacheState>([
  'warm',
  'cold',
  'restored',
  'network',
  'sqlite',
  'mixed',
  'empty',
  'unknown',
]);
const METRICS = new Set<UxMetric>(['elapsed_ms', 'stall_ms', 'blob_size_bytes']);
const SOURCE_EVENTS = new Set<UxSourceEvent>([
  'ux_screen_ready',
  'ux_interaction_latency',
  'ux_js_stall',
  'ux_cache_health',
  'navigation_performance',
  'perf_mark',
]);

let uxContext: Record<string, unknown> = {};

export function setUxTelemetryContext(context: UxTelemetryContext): void {
  uxContext = sanitizeUxProperties({ ...context });
}

export function normalizeUxSurfaceFromPathname(pathname: string): UxSurface {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/(tabs)' || path === '/(tabs)/index') return 'portfolio';
  if (path === '/auth' || path.startsWith('/auth/')) return 'auth';
  if (path === '/onboarding' || path.startsWith('/onboarding/')) return 'onboarding';
  if (path === '/funds' || path === '/(tabs)/funds') return 'funds';
  if (path === '/wealth-journey' || path === '/(tabs)/wealth-journey') return 'wealth_journey';
  if (path === '/settings' || path === '/(tabs)/settings') return 'settings';
  if (path === '/settings/about' || path === '/(tabs)/settings/about') return 'about';
  if (path === '/tools' || path.startsWith('/tools/')) return 'tools';
  if (/^\/fund\/[^/]+$/.test(path)) return 'fund_detail';
  if (path === '/money-trail' || path.startsWith('/money-trail/')) return 'money_trail';
  return 'unknown';
}

export function trackUxScreenReady(input: UxScreenReadyInput): void {
  const threshold =
    input.readiness === 'route_painted'
      ? UX_THRESHOLDS.routePaintMs
      : UX_THRESHOLDS.contentReadyMs;
  const properties = sanitizeUxProperties({
    ...uxContext,
    surface: input.surface,
    readiness: input.readiness,
    elapsed_ms: input.elapsedMs,
    threshold_ms: threshold,
    cold_start: input.coldStart,
    cache_state: input.cacheState ?? 'unknown',
    row_count_bucket: bucketCount(input.rowCount),
    fund_count_bucket: bucketCount(input.fundCount),
    transaction_count_bucket: bucketCount(input.transactionCount),
  });
  analytics.track('ux_screen_ready', properties);
  if (input.elapsedMs >= threshold) {
    trackUxSlowEvent({
      sourceEvent: 'ux_screen_ready',
      surface: input.surface,
      metric: 'elapsed_ms',
      valueMs: input.elapsedMs,
      threshold,
      readiness: input.readiness,
      cacheState: input.cacheState ?? 'unknown',
    });
  }
}

export function trackUxInteractionLatency(input: UxInteractionLatencyInput): void {
  // Staged for future fixed-vocabulary interaction timing call sites. Do not
  // pass dynamic labels here; `action` must remain a bounded enum-like string.
  const properties = sanitizeUxProperties({
    ...uxContext,
    surface: input.surface,
    action: input.action,
    elapsed_ms: input.elapsedMs,
    threshold_ms: UX_THRESHOLDS.interactionMs,
    cache_state: input.cacheState ?? 'unknown',
    row_count_bucket: bucketCount(input.rowCount),
    fund_count_bucket: bucketCount(input.fundCount),
    transaction_count_bucket: bucketCount(input.transactionCount),
  });
  analytics.track('ux_interaction_latency', properties);
  if (input.elapsedMs >= UX_THRESHOLDS.interactionMs) {
    trackUxSlowEvent({
      sourceEvent: 'ux_interaction_latency',
      surface: input.surface,
      metric: 'elapsed_ms',
      valueMs: input.elapsedMs,
      threshold: UX_THRESHOLDS.interactionMs,
      action: input.action,
      cacheState: input.cacheState ?? 'unknown',
    });
  }
}

export function trackUxJsStall(input: UxJsStallInput): void {
  if (input.stallMs < UX_THRESHOLDS.jsStallMs) return;
  const properties = sanitizeUxProperties({
    ...uxContext,
    surface: input.surface,
    stall_ms: input.stallMs,
    threshold_ms: UX_THRESHOLDS.jsStallMs,
  });
  analytics.track('ux_js_stall', properties);
  trackUxSlowEvent({
    sourceEvent: 'ux_js_stall',
    surface: input.surface,
    metric: 'stall_ms',
    valueMs: input.stallMs,
    threshold: UX_THRESHOLDS.jsStallMs,
  });
}

export function trackUxCacheHealth(input: UxCacheHealthInput): void {
  const properties = sanitizeUxProperties({
    ...uxContext,
    cache_state: input.cacheState,
    blob_size_bucket: bucketBytes(input.blobSizeBytes),
    query_count_bucket: bucketCount(input.queryCount),
    buster: input.buster,
  });
  analytics.track('ux_cache_health', properties);
  if (
    typeof input.blobSizeBytes === 'number' &&
    Number.isFinite(input.blobSizeBytes) &&
    input.blobSizeBytes >= UX_THRESHOLDS.cacheBlobBytes
  ) {
    trackUxSlowEvent({
      sourceEvent: 'ux_cache_health',
      surface: 'app',
      metric: 'blob_size_bytes',
      valueBytes: input.blobSizeBytes,
      threshold: UX_THRESHOLDS.cacheBlobBytes,
      cacheState: input.cacheState,
    });
  }
}

export function trackUxSlowEvent(input: UxSlowEventInput): void {
  analytics.track('ux_slow_event', sanitizeUxProperties({
    ...uxContext,
    source_event: input.sourceEvent,
    surface: input.surface,
    metric: input.metric,
    elapsed_ms: input.metric === 'elapsed_ms' ? input.valueMs : undefined,
    stall_ms: input.metric === 'stall_ms' ? input.valueMs : undefined,
    blob_size_bytes: input.valueBytes,
    threshold_ms: input.metric === 'blob_size_bytes' ? undefined : input.threshold,
    threshold_bytes: input.metric === 'blob_size_bytes' ? input.threshold : undefined,
    readiness: input.readiness,
    action: input.action,
    cache_state: input.cacheState,
  }));
}

export function sanitizeUxProperties(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  copyString(input, output, 'platform', 24);
  copyString(input, output, 'app_version', 48);
  copyString(input, output, 'eas_update_id', 64);
  copyString(input, output, 'eas_update_created_at', 48);
  copyString(input, output, 'buster', 24);
  copyAction(input, output);
  copyEnum(input, output, 'surface', SURFACES);
  copyEnum(input, output, 'readiness', READINESS);
  copyEnum(input, output, 'cache_state', CACHE_STATES);
  copyEnum(input, output, 'metric', METRICS);
  copyEnum(input, output, 'source_event', SOURCE_EVENTS);
  copyBucket(input, output, 'row_count_bucket');
  copyBucket(input, output, 'fund_count_bucket');
  copyBucket(input, output, 'transaction_count_bucket');
  copyBucket(input, output, 'query_count_bucket');
  copyBucket(input, output, 'blob_size_bucket');

  for (const key of [
    'elapsed_ms',
    'stall_ms',
    'threshold_ms',
    'blob_size_bytes',
    'threshold_bytes',
  ] as const) {
    copyBoundedNumber(input, output, key);
  }

  for (const key of ['cold_start', 'is_embedded_launch'] as const) {
    if (typeof input[key] === 'boolean') output[key] = input[key];
  }

  return output;
}

export function bucketCount(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return '0';
  if (value <= 10) return '1-10';
  if (value <= 50) return '11-50';
  if (value <= 250) return '51-250';
  if (value <= 1_000) return '251-1000';
  return '1000+';
}

export function bucketBytes(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return '0';
  if (value <= 512_000) return '<=512KB';
  if (value <= 1_000_000) return '512KB-1MB';
  if (value <= 3_000_000) return '1MB-3MB';
  if (value <= 5_000_000) return '3MB-5MB';
  return '5MB+';
}

function copyString(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  const value = input[key];
  if (typeof value === 'string' && value.length > 0) {
    output[key] = value.slice(0, maxLength);
  } else if (value === null) {
    output[key] = null;
  }
}

function copyAction(input: Record<string, unknown>, output: Record<string, unknown>): void {
  const value = input.action;
  if (typeof value !== 'string' || value.length === 0) return;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '_')
    .slice(0, MAX_ACTION_LENGTH);
  if (normalized.length > 0) output.action = normalized;
}

function copyEnum<T extends string>(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  allowed: Set<T>,
): void {
  const value = input[key];
  if (typeof value === 'string' && allowed.has(value as T)) output[key] = value;
}

function copyBucket(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
): void {
  const value = input[key];
  if (typeof value === 'string' && /^[0-9<=>A-Z+.-]+(?:KB|MB)?(?:-[0-9A-Z]+(?:KB|MB)?)?$/.test(value)) {
    output[key] = value;
  }
}

function copyBoundedNumber(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
): void {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
  const max = key === 'blob_size_bytes' || key === 'threshold_bytes'
    ? MAX_SAFE_BYTES
    : MAX_SAFE_METRIC;
  output[key] = Math.min(Math.round(value), max);
}
