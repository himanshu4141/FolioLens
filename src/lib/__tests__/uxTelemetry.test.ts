import { analytics } from '@/src/lib/analytics';
import {
  bucketBytes,
  bucketCount,
  normalizeUxSurfaceFromPathname,
  sanitizeUxProperties,
  setUxTelemetryContext,
  trackUxCacheHealth,
  trackUxJsStall,
  trackUxScreenReady,
} from '@/src/lib/uxTelemetry';

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

describe('uxTelemetry', () => {
  beforeEach(() => {
    mockTrack.mockReset();
    setUxTelemetryContext({});
  });

  it('normalizes routes without retaining dynamic identifiers', () => {
    expect(normalizeUxSurfaceFromPathname('/fund/private-fund-id')).toBe('fund_detail');
    expect(normalizeUxSurfaceFromPathname('/money-trail/private-transaction-id')).toBe('money_trail');
    expect(normalizeUxSurfaceFromPathname('/(tabs)/settings/about')).toBe('about');
    expect(normalizeUxSurfaceFromPathname('/auth/callback?code=secret')).toBe('auth');
    expect(normalizeUxSurfaceFromPathname('/unknown/private')).toBe('unknown');
  });

  it('sanitizes UX properties to low-cardinality safe fields', () => {
    expect(sanitizeUxProperties({
      surface: 'portfolio',
      readiness: 'content_ready',
      cache_state: 'warm',
      metric: 'elapsed_ms',
      source_event: 'ux_screen_ready',
      action: 'Benchmark Switch!',
      elapsed_ms: 123.4,
      threshold_ms: 500,
      cold_start: true,
      row_count_bucket: '51-250',
      fund_id: 'private-fund-id',
      user_id: 'private-user-id',
      pathname: '/fund/private-fund-id',
    })).toEqual({
      surface: 'portfolio',
      readiness: 'content_ready',
      cache_state: 'warm',
      metric: 'elapsed_ms',
      source_event: 'ux_screen_ready',
      action: 'benchmark_switch_',
      elapsed_ms: 123,
      threshold_ms: 500,
      cold_start: true,
      row_count_bucket: '51-250',
    });
  });

  it('buckets counts and cache sizes instead of emitting exact portfolio shape', () => {
    expect(bucketCount(0)).toBe('0');
    expect(bucketCount(7)).toBe('1-10');
    expect(bucketCount(566)).toBe('251-1000');
    expect(bucketCount(5_000)).toBe('1000+');
    expect(bucketBytes(653_800)).toBe('512KB-1MB');
    expect(bucketBytes(5_100_000)).toBe('5MB+');
  });

  it('tracks screen readiness and emits a slow event over threshold', () => {
    setUxTelemetryContext({
      platform: 'android',
      app_version: '1.2.3',
      eas_update_id: 'update-id',
    });

    trackUxScreenReady({
      surface: 'portfolio',
      readiness: 'content_ready',
      elapsedMs: 1_900,
      coldStart: true,
      cacheState: 'restored',
      fundCount: 13,
      transactionCount: 566,
    });

    expect(mockTrack).toHaveBeenCalledWith('ux_screen_ready', expect.objectContaining({
      platform: 'android',
      app_version: '1.2.3',
      eas_update_id: 'update-id',
      surface: 'portfolio',
      readiness: 'content_ready',
      elapsed_ms: 1_900,
      threshold_ms: 1_500,
      cache_state: 'restored',
      fund_count_bucket: '11-50',
      transaction_count_bucket: '251-1000',
    }));
    expect(mockTrack).toHaveBeenCalledWith('ux_slow_event', expect.objectContaining({
      source_event: 'ux_screen_ready',
      surface: 'portfolio',
      metric: 'elapsed_ms',
      elapsed_ms: 1_900,
      threshold_ms: 1_500,
      readiness: 'content_ready',
    }));
  });

  it('only emits JS stall telemetry when the threshold is exceeded', () => {
    trackUxJsStall({ surface: 'funds', stallMs: 120 });
    expect(mockTrack).not.toHaveBeenCalled();

    trackUxJsStall({ surface: 'funds', stallMs: 400 });
    expect(mockTrack).toHaveBeenCalledWith('ux_js_stall', expect.objectContaining({
      surface: 'funds',
      stall_ms: 400,
      threshold_ms: 250,
    }));
    expect(mockTrack).toHaveBeenCalledWith('ux_slow_event', expect.objectContaining({
      source_event: 'ux_js_stall',
      surface: 'funds',
      metric: 'stall_ms',
      stall_ms: 400,
    }));
  });

  it('emits cache health slow events with byte values above the alert threshold', () => {
    trackUxCacheHealth({
      cacheState: 'restored',
      blobSizeBytes: 5_400_000,
      queryCount: 42,
      buster: 'v12',
    });

    expect(mockTrack).toHaveBeenCalledWith('ux_cache_health', expect.objectContaining({
      cache_state: 'restored',
      blob_size_bucket: '5MB+',
      query_count_bucket: '11-50',
      buster: 'v12',
    }));
    expect(mockTrack).toHaveBeenCalledWith('ux_slow_event', expect.objectContaining({
      source_event: 'ux_cache_health',
      surface: 'app',
      metric: 'blob_size_bytes',
      blob_size_bytes: 5_400_000,
      threshold_bytes: 5_000_000,
      cache_state: 'restored',
    }));
  });
});
