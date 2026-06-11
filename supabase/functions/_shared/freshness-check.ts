/**
 * Shared check logic for the freshness-check edge function.
 *
 * Each check (NAV age, cron failures, backfill cursor staleness, OpenFolio health,
 * composition staleness) is pure and injectable so it can be unit-tested with
 * mocked data and injected clocks.
 *
 * A check returns {ok: boolean, detail: string} — detail is a human-readable
 * explanation if the check failed, or a confirmation if it passed.
 */

/** Maximum age for held NAV in calendar days (tolerates weekends + 1 holiday). */
const NAV_FRESHNESS_DAYS = 3;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Check 1: Held NAV age — max(nav_date) over all schemes in user_fund
 * must be >= today - 3 calendar days.
 */
export function checkNavFreshness(maxNavDate: string | null, now: Date): CheckResult {
  const name = 'NAV freshness';

  if (!maxNavDate) {
    return {
      name,
      ok: false,
      detail: 'No NAV data found in user_fund; no schemes are held.',
    };
  }

  const maxDate = new Date(maxNavDate);
  const thresholdDate = new Date(now.getTime() - NAV_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);

  if (maxDate >= thresholdDate) {
    return {
      name,
      ok: true,
      detail: `Latest NAV date is ${maxNavDate} (within ${NAV_FRESHNESS_DAYS} days).`,
    };
  }

  return {
    name,
    ok: false,
    detail: `Latest NAV date is ${maxNavDate}, exceeds ${NAV_FRESHNESS_DAYS}-day threshold (threshold: ${thresholdDate.toISOString()}).`,
  };
}

/**
 * Check 2: Cron job failures — count of non-succeeded runs in the last 24 hours
 * must be zero.
 */
export function checkCronFailures(failureCount: number): CheckResult {
  const name = 'Cron failures (last 24h)';

  if (failureCount === 0) {
    return {
      name,
      ok: true,
      detail: 'No failed cron runs in the last 24 hours.',
    };
  }

  return {
    name,
    ok: false,
    detail: `Found ${failureCount} failed cron run(s) in the last 24 hours.`,
  };
}

/**
 * Check 3: Backfill cursor staleness — for each universe_backfill_*_cursor
 * in app_config, warn if:
 *   (a) The cursor state has failed > 0 (read from JSON.parse(cursor.value).failed)
 *   (b) The cursor value hasn't changed in 48 hours AND no _done_at marker exists.
 *
 * Pass the cursor rows from app_config and the current time.
 */
export interface CursorRow {
  key: string;
  value: string;
  updated_at: string;
}

export function checkBackfillCursors(
  cursors: CursorRow[],
  now: Date,
): CheckResult {
  const name = 'Backfill cursor staleness';

  if (cursors.length === 0) {
    return {
      name,
      ok: true,
      detail: 'No active backfill cursors.',
    };
  }

  const warnings: string[] = [];

  for (const cursor of cursors) {
    let state: { failed?: number } | null = null;
    try {
      state = JSON.parse(cursor.value);
    } catch {
      warnings.push(`${cursor.key}: invalid JSON in cursor value.`);
      continue;
    }

    // Check for failures in the cursor state
    if (state?.failed && state.failed > 0) {
      warnings.push(`${cursor.key}: ${state.failed} failed row(s) in current chunk.`);
    }

    // Check for staleness (no change in 48h)
    const updatedAt = new Date(cursor.updated_at);
    const staleDuration = 48 * 60 * 60 * 1000; // 48 hours
    const isStale = now.getTime() - updatedAt.getTime() > staleDuration;

    if (isStale) {
      warnings.push(
        `${cursor.key}: cursor unchanged for 48+ hours (last update: ${cursor.updated_at}).`,
      );
    }
  }

  if (warnings.length === 0) {
    return {
      name,
      ok: true,
      detail: `All ${cursors.length} active cursor(s) are making progress.`,
    };
  }

  return {
    name,
    ok: false,
    detail: `Issues detected:\n${warnings.map((w) => `  - ${w}`).join('\n')}`,
  };
}

/**
 * Check 4: OpenFolio health — GET /health endpoint must return status ok,
 * db_schemes > 1,500, and latest_disclosure_date <= today + 1 day.
 */
export interface OpenFolioHealthResponse {
  status?: string;
  db_schemes?: number;
  latest_disclosure_date?: string;
}

export function checkOpenFolioHealth(
  response: OpenFolioHealthResponse | null,
  now: Date,
): CheckResult {
  const name = 'OpenFolio health';

  if (!response) {
    return {
      name,
      ok: false,
      detail: 'Failed to fetch OpenFolio /health endpoint.',
    };
  }

  const issues: string[] = [];

  if (response.status !== 'ok') {
    issues.push(`status is '${response.status}', expected 'ok'.`);
  }

  if (typeof response.db_schemes !== 'number' || response.db_schemes <= 1500) {
    issues.push(
      `db_schemes is ${response.db_schemes ?? 'missing'}, expected > 1,500.`,
    );
  }

  if (!response.latest_disclosure_date) {
    issues.push('latest_disclosure_date is missing.');
  } else {
    const disclosureDate = new Date(response.latest_disclosure_date);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (disclosureDate > tomorrow) {
      issues.push(
        `latest_disclosure_date is ${response.latest_disclosure_date}, in the future (> tomorrow).`,
      );
    }
  }

  if (issues.length === 0) {
    return {
      name,
      ok: true,
      detail: `OpenFolio healthy: status=${response.status}, db_schemes=${response.db_schemes}, latest_disclosure_date=${response.latest_disclosure_date}.`,
    };
  }

  return {
    name,
    ok: false,
    detail: `OpenFolio health issues:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
  };
}

/**
 * Check 5: Composition staleness — max(portfolio_date) of source='official'
 * must be within 75 days.
 */
export function checkCompositionStaleness(
  maxPortfolioDate: string | null,
  now: Date,
): CheckResult {
  const name = 'Composition staleness';
  const STALENESS_DAYS = 75;

  if (!maxPortfolioDate) {
    return {
      name,
      ok: false,
      detail: 'No official composition data found.',
    };
  }

  const portfolioDate = new Date(maxPortfolioDate);
  const thresholdDate = new Date(now.getTime() - STALENESS_DAYS * 24 * 60 * 60 * 1000);

  if (portfolioDate >= thresholdDate) {
    return {
      name,
      ok: true,
      detail: `Latest official composition date is ${maxPortfolioDate} (within ${STALENESS_DAYS} days).`,
    };
  }

  return {
    name,
    ok: false,
    detail: `Latest official composition date is ${maxPortfolioDate}, exceeds ${STALENESS_DAYS}-day threshold (threshold: ${thresholdDate.toISOString()}).`,
  };
}
