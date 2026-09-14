import {
  checkBackfillCursors,
  checkCompositionCoverage,
  checkCompositionStaleness,
  checkCronFailures,
  checkDisclosureDateLag,
  checkMetadataCoverage,
  checkNavFreshness,
  checkOpenFolioHealth,
  checkOpenFolioNavAge,
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

  it('returns ok=true when maxNavDate is null (no active non-matured schemes, skip check)', () => {
    const result = checkNavFreshness(null, now);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('non-matured');
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
      db_nav_latest: '2026-06-10',
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
      db_nav_latest: '2026-06-10',
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
      db_nav_latest: '2026-06-10',
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
      db_nav_latest: '2026-06-10',
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
      db_nav_latest: '2026-06-10',
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
      db_nav_latest: '2026-06-10',
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when db_nav_latest is missing', () => {
    const response: OpenFolioHealthResponse = {
      status: 'ok',
      db_schemes: 2000,
      latest_disclosure_date: '2026-06-11',
    };
    const result = checkOpenFolioHealth(response, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('db_nav_latest');
  });
});

describe('checkOpenFolioNavAge', () => {
  // 2026-06-11 is a Thursday (weekday). 2026-06-12/13/14/15 are Fri/Sat/Sun/Mon.
  const weekday = new Date('2026-06-11T08:00:00.000Z');

  it('returns ok=true when db_nav_latest is 1 trading day old', () => {
    // Wednesday -> Thursday.
    const result = checkOpenFolioNavAge('2026-06-10', weekday);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('OpenFolio NAV age');
  });

  it('returns ok=true when db_nav_latest is exactly at the 2-trading-day threshold', () => {
    // Tuesday -> Thursday: 2 trading days (Wed, Thu).
    const result = checkOpenFolioNavAge('2026-06-09', weekday);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when db_nav_latest is older than the threshold — the frozen-upstream scenario', () => {
    // Mirrors the 2026-09 incident: /health status=ok but db_nav_latest frozen for weeks.
    const today = new Date('2026-09-10T08:00:00.000Z'); // Thursday
    const result = checkOpenFolioNavAge('2026-08-18', today);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('2026-08-18');
    expect(result.detail).toContain('frozen');
  });

  it('returns ok=false when db_nav_latest is missing', () => {
    const result = checkOpenFolioNavAge(null, weekday);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('did not report');
  });

  it('returns ok=false when db_nav_latest is missing, even on a weekend', () => {
    // A missing field is a /health shape problem, not a "no new NAV over the
    // weekend" non-issue — it must not be masked by the day of the week.
    const sunday = new Date('2026-06-14T08:00:00.000Z');
    const result = checkOpenFolioNavAge(null, sunday);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false on a weekend when db_nav_latest is genuinely stale', () => {
    const saturday = new Date('2026-06-13T08:00:00.000Z');
    const result = checkOpenFolioNavAge('2026-05-01', saturday);
    expect(result.ok).toBe(false);
  });

  // Regression coverage for the Monday false-positive: a calendar-day
  // threshold checked at a fixed instant misreads Friday's genuinely fresh
  // NAV as stale by Monday morning (3 days 8 hours by wall clock, against a
  // 3-calendar-day threshold), even though it is the correct, current value.
  it('returns ok=true on a Monday morning check against Friday\'s still-fresh NAV', () => {
    const monday = new Date('2026-06-15T08:00:00.000Z');
    const result = checkOpenFolioNavAge('2026-06-12', monday); // Friday
    expect(result.ok).toBe(true);
  });

  it('returns ok=true on a Tuesday check against Friday\'s NAV when Monday was a holiday', () => {
    // Trading-day counting has no holiday calendar, so a Monday holiday
    // still counts as one trading-day slot — Fri -> Tue is 2 trading days,
    // exactly at the threshold, not a false failure.
    const tuesday = new Date('2026-06-16T08:00:00.000Z');
    const result = checkOpenFolioNavAge('2026-06-12', tuesday); // Friday
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

describe('checkMetadataCoverage (monthly)', () => {
  it('returns ok=true when coverage >= 95%', () => {
    const result = checkMetadataCoverage(9500, 10000);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Metadata coverage');
    expect(result.detail).toContain('95%');
  });

  it('returns ok=true when coverage is exactly 95%', () => {
    const result = checkMetadataCoverage(950, 1000);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('95%');
  });

  it('returns ok=false when coverage < 95%', () => {
    const result = checkMetadataCoverage(9400, 10000);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('94%');
    expect(result.detail).toContain('95%');
  });

  it('returns ok=false when upstream total is 0', () => {
    const result = checkMetadataCoverage(100, 0);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('0');
  });

  it('calculates coverage correctly with large numbers', () => {
    const result = checkMetadataCoverage(35730, 37595);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('95%');
  });
});

describe('checkCompositionCoverage (monthly)', () => {
  it('returns ok=true when coverage >= 95%', () => {
    const result = checkCompositionCoverage(9500, 10000);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Composition coverage');
    expect(result.detail).toContain('95%');
  });

  it('returns ok=true when coverage is exactly 95%', () => {
    const result = checkCompositionCoverage(950, 1000);
    expect(result.ok).toBe(true);
  });

  it('returns ok=false when coverage < 95%', () => {
    const result = checkCompositionCoverage(9400, 10000);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('94%');
  });

  it('returns ok=false when upstream total is 0', () => {
    const result = checkCompositionCoverage(100, 0);
    expect(result.ok).toBe(false);
  });
});

describe('checkDisclosureDateLag (monthly)', () => {
  const now = new Date('2026-06-11T12:00:00.000Z');

  it('returns ok=true when lag is within 45 days', () => {
    const portfolioDate = '2026-06-01';
    const disclosureDate = '2026-06-11';
    const result = checkDisclosureDateLag(portfolioDate, disclosureDate, now);
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Disclosure date lag');
    expect(result.detail).toContain('10 days');
  });

  it('returns ok=true when lag is exactly 45 days', () => {
    const portfolioDate = '2026-04-27';
    const disclosureDate = '2026-06-11';
    const result = checkDisclosureDateLag(portfolioDate, disclosureDate, now);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('45 days');
  });

  it('returns ok=false when lag exceeds 45 days', () => {
    const portfolioDate = '2026-04-26';
    const disclosureDate = '2026-06-11';
    const result = checkDisclosureDateLag(portfolioDate, disclosureDate, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('46 days');
  });

  it('returns ok=false when portfolio_date is null', () => {
    const result = checkDisclosureDateLag(null, '2026-06-11', now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Missing data');
  });

  it('returns ok=false when disclosure_date is null', () => {
    const result = checkDisclosureDateLag('2026-06-01', null, now);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Missing data');
  });

  it('handles same-day disclosure and portfolio dates', () => {
    const date = '2026-06-11';
    const result = checkDisclosureDateLag(date, date, now);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('0 days');
  });
});
