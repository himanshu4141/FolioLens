/**
 * Pure helpers for the sync-nav since-map: building a per-scheme latest
 * nav_date map from paginated PostgREST rows.
 *
 * Extracted so they can be unit-tested without a live Supabase connection.
 * Callers must paginate using SINCE_MAP_PAGE_SIZE to avoid the 1,000-row
 * PostgREST default cap.
 */

/** PostgREST hard cap — use as the page size when ranging nav_history. */
export const SINCE_MAP_PAGE_SIZE = 1000;

/**
 * Build a per-scheme latest nav_date map from rows returned in descending
 * nav_date order.  The first occurrence of each scheme_code is the maximum
 * date (since descending); duplicates are ignored, preserving that invariant.
 */
export function buildSchemeLatestMap(
  rows: { scheme_code: number; nav_date: string }[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const row of rows) {
    if (!map.has(row.scheme_code)) {
      map.set(row.scheme_code, row.nav_date);
    }
  }
  return map;
}

export interface NavFreshnessGateResult {
  shouldSkip: boolean;
  reason: string;
  upstreamLatestDate: string | null;
  localMinLatestDate: string | null;
  missingSchemeCount: number;
  staleSchemeCount: number;
  currentSchemeCount: number;
  syncSchemeCount: number;
  /** true when db_nav_latest itself is stale (older than maxUpstreamAgeTradingDays). */
  upstreamStale: boolean;
  /** Trading-day age of upstreamLatestDate as of `today`; null when upstreamLatestDate is invalid. */
  upstreamAgeTradingDays: number | null;
}

export interface NavFreshnessGateEvaluation extends NavFreshnessGateResult {
  syncSchemeCodes: number[];
}

/** Default trading-day age past which db_nav_latest is treated as stale, not just "not current". */
export const DEFAULT_MAX_UPSTREAM_AGE_TRADING_DAYS = 2;

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Count Indian trading days (Mon–Fri) strictly after `fromIso` up to and
 * including the calendar date of `today`. Holidays are not modelled — the
 * caller's threshold absorbs the odd one via a small trading-day cushion
 * rather than an exact NSE holiday calendar.
 */
export function tradingDaysAge(fromIso: string, today: Date): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (to.getTime() <= from.getTime()) return 0;

  let count = 0;
  const cursor = new Date(from);
  while (cursor.getTime() < to.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

/**
 * Decide whether sync-nav can skip OpenFolio per-scheme fanout.
 *
 * The gate is intentionally per-scheme: a fresh max(nav_date) is not enough,
 * because one held scheme can lag while another scheme is current. Skip only
 * when every active held scheme has local NAV through OpenFolio's latest NAV
 * date. Missing or stale schemes fall through to the existing per-scheme sync.
 *
 * A healthy-looking upstream can still be *stale* — OpenFolio reporting the
 * same db_nav_latest for days on end while its own parser is frozen (see
 * docs/plans/amfi-nav-format-change.md). When db_nav_latest itself is older
 * than `maxUpstreamAgeTradingDays` trading days as of `today`, treat OpenFolio
 * as untrustworthy for this run: never skip, and route every held scheme whose
 * *local* NAV is also that stale straight to the mfapi fallback rather than
 * trusting OpenFolio's delta/incremental endpoints.
 */
export function evaluateOpenFolioNavFreshnessGate(
  schemeCodes: number[],
  schemeLatest: Map<number, string>,
  upstreamLatestDate: string | null | undefined,
  today: Date,
  maxUpstreamAgeTradingDays: number = DEFAULT_MAX_UPSTREAM_AGE_TRADING_DAYS,
): NavFreshnessGateEvaluation {
  if (!isIsoDate(upstreamLatestDate)) {
    return {
      shouldSkip: false,
      reason: 'OpenFolio health did not include a valid db_nav_latest date.',
      upstreamLatestDate: null,
      localMinLatestDate: null,
      missingSchemeCount: 0,
      staleSchemeCount: 0,
      currentSchemeCount: 0,
      syncSchemeCount: schemeCodes.length,
      syncSchemeCodes: [...schemeCodes],
      upstreamStale: false,
      upstreamAgeTradingDays: null,
    };
  }

  const upstreamAgeTradingDays = tradingDaysAge(upstreamLatestDate, today);
  const upstreamStale = upstreamAgeTradingDays > maxUpstreamAgeTradingDays;

  let localMinLatestDate: string | null = null;
  let missingSchemeCount = 0;
  let staleSchemeCount = 0;
  let currentSchemeCount = 0;
  const syncSchemeCodes: number[] = [];

  if (upstreamStale) {
    // OpenFolio's own watermark can't be trusted this run. Route every held
    // scheme whose *local* NAV is itself stale (independent of what OpenFolio
    // claims) to the mfapi fallback; schemes already fresh — e.g. synced by a
    // prior stale-routing run — don't need another fetch.
    for (const schemeCode of schemeCodes) {
      const localLatest = schemeLatest.get(schemeCode);
      if (!isIsoDate(localLatest)) {
        missingSchemeCount += 1;
        syncSchemeCodes.push(schemeCode);
        continue;
      }
      if (localMinLatestDate === null || localLatest < localMinLatestDate) {
        localMinLatestDate = localLatest;
      }
      if (tradingDaysAge(localLatest, today) > maxUpstreamAgeTradingDays) {
        staleSchemeCount += 1;
        syncSchemeCodes.push(schemeCode);
      } else {
        currentSchemeCount += 1;
      }
    }

    return {
      shouldSkip: false,
      reason: `Upstream stale: db_nav_latest (${upstreamLatestDate}) lags ${upstreamAgeTradingDays} trading day(s), exceeds ${maxUpstreamAgeTradingDays}-day threshold; routing ${syncSchemeCodes.length} held scheme(s) directly to mfapi.`,
      upstreamLatestDate,
      localMinLatestDate,
      missingSchemeCount,
      staleSchemeCount,
      currentSchemeCount,
      syncSchemeCount: syncSchemeCodes.length,
      syncSchemeCodes,
      upstreamStale: true,
      upstreamAgeTradingDays,
    };
  }

  for (const schemeCode of schemeCodes) {
    const localLatest = schemeLatest.get(schemeCode);
    if (!isIsoDate(localLatest)) {
      missingSchemeCount += 1;
      syncSchemeCodes.push(schemeCode);
      continue;
    }
    if (localMinLatestDate === null || localLatest < localMinLatestDate) {
      localMinLatestDate = localLatest;
    }
    if (localLatest < upstreamLatestDate) {
      staleSchemeCount += 1;
      syncSchemeCodes.push(schemeCode);
    } else {
      currentSchemeCount += 1;
    }
  }

  if (missingSchemeCount > 0 || staleSchemeCount > 0) {
    return {
      shouldSkip: false,
      reason: `Held NAV not fully current: missing=${missingSchemeCount}, stale=${staleSchemeCount}; syncing ${syncSchemeCodes.length} scheme(s).`,
      upstreamLatestDate,
      localMinLatestDate,
      missingSchemeCount,
      staleSchemeCount,
      currentSchemeCount,
      syncSchemeCount: syncSchemeCodes.length,
      syncSchemeCodes,
      upstreamStale: false,
      upstreamAgeTradingDays,
    };
  }

  return {
    shouldSkip: true,
    reason: `All ${schemeCodes.length} held schemes are current through ${upstreamLatestDate}.`,
    upstreamLatestDate,
    localMinLatestDate,
    missingSchemeCount,
    staleSchemeCount,
    currentSchemeCount,
    syncSchemeCount: 0,
    syncSchemeCodes: [],
    upstreamStale: false,
    upstreamAgeTradingDays,
  };
}

export interface OpenFolioResultFreshness {
  /** true when the date is fresh enough to trust without falling through to mfapi. */
  fresh: boolean;
  /** Trading-day age of `dateIso` as of `today`. */
  ageTradingDays: number;
}

/**
 * Freshness check `fetch-fund-nav` applies to whichever date it's about to
 * trust from OpenFolio — the post-upsert latest NAV date when OF returned
 * points, or `since` when OF reports no new points against it. One
 * definition shared by both call sites, so a fix to the threshold or
 * comparison can't land at one and leave the other's own inline copy
 * behind — that's exactly what happened to fetch-fund-nav's empty-points-only
 * guard before it was extended to cover the non-empty case too (see PR #312
 * review history). Same trading-day semantics as the sync-nav gate above and
 * checkOpenFolioNavAge in freshness-check.ts.
 */
export function checkOpenFolioResultFreshness(
  dateIso: string,
  today: Date,
  maxUpstreamAgeTradingDays: number = DEFAULT_MAX_UPSTREAM_AGE_TRADING_DAYS,
): OpenFolioResultFreshness {
  const ageTradingDays = tradingDaysAge(dateIso, today);
  return { fresh: ageTradingDays <= maxUpstreamAgeTradingDays, ageTradingDays };
}

/** Low-cardinality bucket for analytics — never emit the raw day count as a free property. */
export function upstreamAgeBucket(ageTradingDays: number | null): '0-1' | '2-3' | '4-7' | '8+' | null {
  if (ageTradingDays === null) return null;
  if (ageTradingDays <= 1) return '0-1';
  if (ageTradingDays <= 3) return '2-3';
  if (ageTradingDays <= 7) return '4-7';
  return '8+';
}
