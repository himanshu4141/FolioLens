import {
  checkBackfillCursors,
  checkCompositionStaleness,
  checkCronFailures,
  checkNavFreshness,
  checkOpenFolioHealth,
  type CursorRow,
  type OpenFolioHealthResponse,
} from '../freshness-check';

describe('checkNavFreshness', () => {
  const now = new Date('2026-06-11T12:00:00.000Z');
  const threshold = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days back

  it('returns ok=true when maxNavDate is within 3 days', () => {
    const result = checkNavFreshness('2026-06-10T00:00:00.000Z', now);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('NAV freshness');
  });

  it('returns ok=true when maxNavDate is exactly at threshold', () => {
    const result = checkNavFreshness(threshold.toISOString(), now);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when maxNavDate is older than 3 days', () => {
    const result = checkNavFreshness('2026-06-07T00:00:00.000Z', now);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when maxNavDate is null', () => {
    const result = checkNavFreshness(null, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('No NAV data');
  });

  it('returns ok=true on a Friday for a Monday NAV (weekend tolerance)', () => {
    // Friday 2026-06-12
    const friday = new Date('2026-06-12T12:00:00.000Z');
    // Tuesday 2026-06-10 (2 days before Friday, within 3-day threshold)
    const tuesday = new Date('2026-06-10T12:00:00.000Z');
    const result = checkNavFreshness(tuesday.toISOString(), friday);
    expect(result.ok).toBe(true);
  });
});

describe('checkCronFailures', () => {
  it('returns ok=true when failureCount is 0', () => {
    const result = checkCronFailures(0);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Cron failures (last 24h)');
  });

  it('returns ok=false when failureCount > 0', () => {
    const result = checkCronFailures(5);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('5');
  });

  it('returns ok=false when failureCount is 1', () => {
    const result = checkCronFailures(1);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('1');
  });
});

describe('checkBackfillCursors', () => {
  const now = new Date('2026-06-11T12:00:00.000Z');

  it('returns ok=true when no cursors are present', () => {
    const result = checkBackfillCursors([], now);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Backfill cursor staleness');
    expect(result.detail).toContain('No active backfill cursors');
  });

  it('returns ok=true when cursor is recent and has no failures', () => {
    const cursor: CursorRow = {
      key: 'universe_backfill_composition_cursor',
      value: JSON.stringify({ phase: 'composition', failed: 0, cursor: 10 }),
      updated_at: '2026-06-11T11:00:00.000Z',
    };
    const result = checkBackfillCursors([cursor], now);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when cursor has failed > 0', () => {
    const cursor: CursorRow = {
      key: 'universe_backfill_composition_cursor',
      value: JSON.stringify({ phase: 'composition', failed: 3, cursor: 10 }),
      updated_at: '2026-06-11T11:00:00.000Z',
    };
    const result = checkBackfillCursors([cursor], now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('3 failed row(s)');
  });

  it('returns ok=false when cursor is stale (unchanged for 48+ hours)', () => {
    const staleTime = new Date(now.getTime() - 49 * 60 * 60 * 1000); // 49 hours ago
    const cursor: CursorRow = {
      key: 'universe_backfill_metadata_cursor',
      value: JSON.stringify({ phase: 'metadata', failed: 0, cursor: 5 }),
      updated_at: staleTime.toISOString(),
    };
    const result = checkBackfillCursors([cursor], now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unchanged for 48+ hours');
  });

  it('returns ok=true when cursor is exactly at 48-hour boundary', () => {
    const boundaryTime = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const cursor: CursorRow = {
      key: 'universe_backfill_composition_cursor',
      value: JSON.stringify({ phase: 'composition', failed: 0, cursor: 10 }),
      updated_at: boundaryTime.toISOString(),
    };
    const result = checkBackfillCursors([cursor], now);
    expect(result.ok).toBe(true);
  });

  it('handles invalid JSON in cursor value gracefully', () => {
    const cursor: CursorRow = {
      key: 'universe_backfill_composition_cursor',
      value: 'not valid json',
      updated_at: '2026-06-11T11:00:00.000Z',
    };
    const result = checkBackfillCursors([cursor], now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('invalid JSON');
  });

  it('combines multiple warnings for a single stale cursor with failures', () => {
    const staleTime = new Date(now.getTime() - 49 * 60 * 60 * 1000);
    const cursor: CursorRow = {
      key: 'universe_backfill_composition_cursor',
      value: JSON.stringify({ phase: 'composition', failed: 2, cursor: 10 }),
      updated_at: staleTime.toISOString(),
    };
    const result = checkBackfillCursors([cursor], now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('2 failed row(s)');
    expect(result.detail).toContain('unchanged for 48+ hours');
  });
});

describe('checkOpenFolioHealth', () => {
  const now = new Date('2026-06-11T12:00:00.000Z');

  it('returns ok=true when health response is fully valid', () => {
    const response: OpenFolioHealthResponse = {
      status: 'ok',
      db_schemes: 2000,
      latest_disclosure_date: '2026-06-11',
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('OpenFolio health');
  });

  it('returns ok=false when response is null', () => {
    const result = checkOpenFolioHealth(null, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Failed to fetch');
  });

  it('returns ok=false when status is not ok', () => {
    const response: OpenFolioHealthResponse = {
      status: 'error',
      db_schemes: 2000,
      latest_disclosure_date: '2026-06-11',
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('status is');
  });

  it('returns ok=false when db_schemes <= 1500', () => {
    const response: OpenFolioHealthResponse = {
      status: 'ok',
      db_schemes: 1500,
      latest_disclosure_date: '2026-06-11',
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('db_schemes');
  });

  it('returns ok=false when latest_disclosure_date is in the future', () => {
    const futureDate = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days in future
    const response: OpenFolioHealthResponse = {
      status: 'ok',
      db_schemes: 2000,
      latest_disclosure_date: futureDate.toISOString().split('T')[0],
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('in the future');
  });

  it('returns ok=true when latest_disclosure_date is today', () => {
    const today = now.toISOString().split('T')[0];
    const response: OpenFolioHealthResponse = {
      status: 'ok',
      db_schemes: 2000,
      latest_disclosure_date: today,
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(true);
  });

  it('returns ok=true when latest_disclosure_date is yesterday', () => {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    const response: OpenFolioHealthResponse = {
      status: 'ok',
      db_schemes: 2000,
      latest_disclosure_date: yesterday,
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(true);
  });
});

describe('checkCompositionStaleness', () => {
  const now = new Date('2026-06-11T12:00:00.000Z');
  const threshold = new Date(now.getTime() - 75 * 24 * 60 * 60 * 1000); // 75 days back

  it('returns ok=true when maxPortfolioDate is within 75 days', () => {
    const result = checkCompositionStaleness('2026-06-10T00:00:00.000Z', now);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Composition staleness');
  });

  it('returns ok=true when maxPortfolioDate is exactly at threshold', () => {
    const result = checkCompositionStaleness(threshold.toISOString(), now);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when maxPortfolioDate is older than 75 days', () => {
    const old = new Date(now.getTime() - 76 * 24 * 60 * 60 * 1000);
    const result = checkCompositionStaleness(old.toISOString(), now);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when maxPortfolioDate is null', () => {
    const result = checkCompositionStaleness(null, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('No official composition data');
  });
});
