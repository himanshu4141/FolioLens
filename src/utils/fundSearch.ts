/**
 * Search across the full scheme_master catalog (~37k rows after the M3v2
 * seed). Powers the UniversalFundPicker used by Compare Funds and (in PR B)
 * Past SIP Check.
 *
 * The picker queries are debounced upstream; this module keeps the supabase
 * call shape lean. We rely on the gin_trgm index on scheme_name added by the
 * M3v2 migration so ilike stays fast at scale.
 */
import { schemeMasterRepo } from '@/src/lib/data/schemeMaster';
import { userFundRepo } from '@/src/lib/data/userFund';
export { shortSchemeName } from './schemeName';

export interface SchemeSearchResult {
  schemeCode: number;
  schemeName: string;
  schemeCategory: string | null;
  sebiCategory: string | null;
  amcName: string | null;
  planType: 'direct' | 'regular' | null;
  isin: string | null;
  schemeActive: boolean | null;
}

/**
 * Split a free-text query into search tokens: lowercased, stripped of
 * punctuation (so "&", "-", "." don't break the PostgREST or-filter syntax),
 * and dropping fragments under 2 chars. "Large & Mid Cap Direct" →
 * ["large", "mid", "cap", "direct"]. Exported for tests.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 2);
}

const SEARCH_COLUMNS =
  'scheme_code, scheme_name, scheme_category, sebi_category, amc_name, plan_type, isin, scheme_active';

function mapSearchRow(row: Record<string, unknown>): SchemeSearchResult {
  return {
    schemeCode: row.scheme_code as number,
    schemeName: row.scheme_name as string,
    schemeCategory: (row.scheme_category as string | null) ?? null,
    sebiCategory: (row.sebi_category as string | null) ?? null,
    amcName: (row.amc_name as string | null) ?? null,
    planType: (row.plan_type as 'direct' | 'regular' | null) ?? null,
    isin: (row.isin as string | null) ?? null,
    schemeActive: (row.scheme_active as boolean | null) ?? null,
  };
}

export interface SchemeSearchOptions {
  /** Free-text query — matched as ilike '%term%' against scheme_name. */
  query?: string;
  /** Optional AMC filter — exact match against scheme_master.amc_name. */
  amcName?: string | null;
  /** Optional category filter — exact match against scheme_master.scheme_category. */
  category?: string | null;
  /** Pagination — first row offset (default 0). */
  offset?: number;
  /** Pagination — max rows returned (default 25). */
  limit?: number;
}

/**
 * Fetch a page of scheme_master rows matching the search criteria.
 *
 * Matching model:
 *   - query is tokenised on whitespace; EVERY token must match (AND) — and a
 *     token matches if it appears in scheme_name OR sebi_category OR amc_name
 *     (each an `ilike '%token%'`). This makes word-order-independent, partial
 *     queries work: "large & mid cap direct" finds "… Large & Mid Cap Fund -
 *     Direct Plan - Growth" even though those words aren't contiguous, and a
 *     bare "midcap hdfc" matches on name + AMC. Relies on the gin_trgm index
 *     on scheme_name so the ilike stays fast at ~37k rows.
 *   - amcName (eq) and category (eq, on scheme_category) further narrow.
 * All combined with AND. Empty query returns the alphabetic-by-name first
 * page when no filters are set.
 *
 * RLS allows authenticated users to read scheme_master.
 */
export async function searchSchemes(
  options: SchemeSearchOptions = {},
): Promise<SchemeSearchResult[]> {
  const { query = '', amcName, category, offset = 0, limit = 25 } = options;

  let q = schemeMasterRepo
    .from()
    .select(SEARCH_COLUMNS)
    .order('scheme_active', { ascending: false, nullsFirst: false })
    .order('scheme_name', { ascending: true })
    .range(offset, offset + limit - 1);

  // Each token becomes an OR group across the searchable columns; chaining
  // .or() calls ANDs the groups together — so all tokens must match, each in
  // any one column.
  for (const token of tokenizeQuery(query)) {
    const safe = token.replace(/[(),*]/g, ''); // defensive: keep PostgREST filter grammar intact
    if (!safe) continue;
    q = q.or(
      `scheme_name.ilike.%${safe}%,sebi_category.ilike.%${safe}%,amc_name.ilike.%${safe}%`,
    );
  }
  if (amcName) {
    q = q.eq('amc_name', amcName);
  }
  if (category) {
    q = q.eq('scheme_category', category);
  }

  const { data, error } = await q;
  if (error) throw new Error(`searchSchemes failed: ${error.message}`);
  return (data ?? []).map(mapSearchRow);
}

/**
 * Fetch the user's held funds — a separate query so the UI can pin them at
 * the top of the picker as a "Your funds" section. Joins user_fund to
 * scheme_master to surface scheme metadata.
 */
export async function fetchUserHeldSchemes(userId: string): Promise<SchemeSearchResult[]> {
  const { data: holdings, error: holdingsError } = await userFundRepo
    .from()
    .select('scheme_code')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (holdingsError) throw new Error(`fetchUserHeldSchemes (holdings) failed: ${holdingsError.message}`);
  const codes = [...new Set((holdings ?? []).map((r) => r.scheme_code as number))];
  if (codes.length === 0) return [];

  const { data, error } = await schemeMasterRepo
    .from()
    .select(SEARCH_COLUMNS)
    .in('scheme_code', codes)
    .order('scheme_name', { ascending: true });
  if (error) throw new Error(`fetchUserHeldSchemes (master) failed: ${error.message}`);
  return (data ?? []).map(mapSearchRow);
}

