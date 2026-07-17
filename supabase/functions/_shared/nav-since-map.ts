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
}

export interface NavFreshnessGateEvaluation extends NavFreshnessGateResult {
  syncSchemeCodes: number[];
}

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Decide whether sync-nav can skip OpenFolio per-scheme fanout.
 *
 * The gate is intentionally per-scheme: a fresh max(nav_date) is not enough,
 * because one held scheme can lag while another scheme is current. Skip only
 * when every active held scheme has local NAV through OpenFolio's latest NAV
 * date. Missing or stale schemes fall through to the existing per-scheme sync.
 */
export function evaluateOpenFolioNavFreshnessGate(
  schemeCodes: number[],
  schemeLatest: Map<number, string>,
  upstreamLatestDate: string | null | undefined,
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
    };
  }

  let localMinLatestDate: string | null = null;
  let missingSchemeCount = 0;
  let staleSchemeCount = 0;
  let currentSchemeCount = 0;
  const syncSchemeCodes: number[] = [];

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
  };
}
