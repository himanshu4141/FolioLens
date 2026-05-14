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
  amcName: string | null;
  planType: 'direct' | 'regular' | null;
  isin: string | null;
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
 * Query precedence:
 *   - query (ilike '%...%' on scheme_name)
 *   - amcName (eq)
 *   - category (eq)
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
    .select('scheme_code, scheme_name, scheme_category, amc_name, plan_type, isin')
    .order('scheme_name', { ascending: true })
    .range(offset, offset + limit - 1);

  const trimmed = query.trim();
  if (trimmed.length >= 2) {
    q = q.ilike('scheme_name', `%${trimmed}%`);
  }
  if (amcName) {
    q = q.eq('amc_name', amcName);
  }
  if (category) {
    q = q.eq('scheme_category', category);
  }

  const { data, error } = await q;
  if (error) throw new Error(`searchSchemes failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    schemeCode: row.scheme_code as number,
    schemeName: row.scheme_name as string,
    schemeCategory: (row.scheme_category as string | null) ?? null,
    amcName: (row.amc_name as string | null) ?? null,
    planType: (row.plan_type as 'direct' | 'regular' | null) ?? null,
    isin: (row.isin as string | null) ?? null,
  }));
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
    .select('scheme_code, scheme_name, scheme_category, amc_name, plan_type, isin')
    .in('scheme_code', codes)
    .order('scheme_name', { ascending: true });
  if (error) throw new Error(`fetchUserHeldSchemes (master) failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    schemeCode: row.scheme_code as number,
    schemeName: row.scheme_name as string,
    schemeCategory: (row.scheme_category as string | null) ?? null,
    amcName: (row.amc_name as string | null) ?? null,
    planType: (row.plan_type as 'direct' | 'regular' | null) ?? null,
    isin: (row.isin as string | null) ?? null,
  }));
}

