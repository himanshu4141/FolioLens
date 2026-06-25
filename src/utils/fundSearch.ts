/**
 * Search across the full scheme_master catalog (~37k rows after the M3v2
 * seed). Powers the UniversalFundPicker used by Compare Funds and Past SIP
 * Check.
 *
 * Two search modes:
 *   1. Plan-level (searchSchemes) — one row per AMFI scheme code. Used by
 *      Past SIP Check (single-select) and as a fallback for families without
 *      an of_family_id.
 *   2. Family-level (searchFamilies) — one row per of_family_id, collapsing
 *      ~8,347 plan variants to ~2,046 logical fund families. Used by Compare
 *      Funds (multi-select). The family view is backed by the
 *      `v_fund_family_search` DB view added in migration
 *      20260624000000_fund_family_search_view.sql.
 *
 * The picker queries are debounced upstream; this module keeps the supabase
 * call shape lean. We rely on the gin_trgm index on scheme_name added by the
 * M3v2 migration so ilike stays fast at scale.
 */
import { schemeMasterRepo } from '@/src/lib/data/schemeMaster';
import { schemeFamilySearchRepo } from '@/src/lib/data/schemeFamilySearch';
import { userFundRepo } from '@/src/lib/data/userFund';
export { shortSchemeName } from './schemeName';

// ---------------------------------------------------------------------------
// Plan-level types (existing)
// ---------------------------------------------------------------------------

export interface SchemeSearchResult {
  schemeCode: number;
  schemeName: string;
  schemeCategory: string | null;
  sebiCategory: string | null;
  amcName: string | null;
  planType: 'direct' | 'regular' | null;
  isin: string | null;
  schemeActive: boolean | null;
  openfolioMetaSyncedAt: string | null;
}

// ---------------------------------------------------------------------------
// Family-level types (new — family-first picker §6.5)
// ---------------------------------------------------------------------------

/** One row per of_family_id returned by v_fund_family_search / searchFamilies. */
export interface FamilySearchResult {
  ofFamilyId: string;
  familyName: string | null;
  amcName: string | null;
  sebiCategory: string | null;
  schemeCategory: string | null;
  hasDirect: boolean;
  hasRegular: boolean;
  hasGrowth: boolean;
  hasIdcw: boolean;
  representativeSchemeCode: number;
  familyActive: boolean;
}

/**
 * One plan/option variant for a fund family, fetched from scheme_master
 * when a family is selected to allow client-side plan resolution.
 */
export interface FamilyPlan {
  schemeCode: number;
  planType: 'direct' | 'regular' | null;
  optionType: string | null;
}

/** User preference for which plan/option variant to show. */
export interface PlanPreference {
  planType: 'direct' | 'regular';
  optionType: 'growth' | 'idcw';
}

/** Result of resolving a family to a concrete scheme_code. */
export interface FamilyResolution {
  schemeCode: number;
  planType: 'direct' | 'regular' | null;
  optionType: string | null;
  /** True when the preferred combo was not available and a fallback was used. */
  isFallback: boolean;
  /**
   * Human-readable fallback reason shown in the picker chip.
   * e.g. "Regular-only", "IDCW-only", "Direct-only".
   * Null when isFallback is false.
   */
  fallbackReason: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

/**
 * Resolve a fund family's available plans to the best scheme_code for a
 * given plan/option preference. Pure function — no I/O, fully testable.
 *
 * Resolution order:
 *   1. Exact match: preferred planType + preferred optionType (payout > reinvest)
 *   2. Preferred optionType with any planType ("Regular-only" fallback)
 *   3. Preferred planType with any optionType ("IDCW-only" fallback)
 *   4. Any plan/option (last resort)
 *
 * When optionType is 'idcw', prefers idcw_payout > idcw > idcw_reinvest.
 * Returns null only when plans is empty.
 */
export function resolveFamilyToScheme(
  plans: FamilyPlan[],
  preference: PlanPreference,
): FamilyResolution | null {
  if (plans.length === 0) return null;

  const { planType: preferredPlan, optionType: preferredOption } = preference;

  const matchesOptionPref = (ot: string | null): boolean => {
    if (!ot) return false;
    if (preferredOption === 'growth') return ot === 'growth';
    return ['idcw_payout', 'idcw_reinvest', 'idcw', 'dividend_payout', 'dividend_reinvest'].includes(ot);
  };

  // idcw_payout is preferred over idcw_reinvest for IDCW preference.
  const idcwRank = (ot: string | null): number => {
    switch (ot) {
      case 'idcw_payout':
      case 'dividend_payout': return 0;
      case 'idcw': return 1;
      case 'idcw_reinvest':
      case 'dividend_reinvest': return 2;
      default: return 99;
    }
  };

  const sortIdcw = (a: FamilyPlan, b: FamilyPlan) => idcwRank(a.optionType) - idcwRank(b.optionType);

  // 1. Exact match.
  const exact = plans.filter(
    (p) => p.planType === preferredPlan && matchesOptionPref(p.optionType),
  );
  if (exact.length > 0) {
    const best = [...exact].sort(sortIdcw)[0];
    return {
      schemeCode: best.schemeCode,
      planType: best.planType,
      optionType: best.optionType,
      isFallback: false,
      fallbackReason: null,
    };
  }

  // 2. Preferred optionType, any planType.
  const optionMatch = plans.filter((p) => matchesOptionPref(p.optionType));
  if (optionMatch.length > 0) {
    const best = [...optionMatch].sort(sortIdcw)[0];
    const actualLabel = best.planType === 'regular' ? 'Regular-only' : 'Direct-only';
    return {
      schemeCode: best.schemeCode,
      planType: best.planType,
      optionType: best.optionType,
      isFallback: true,
      fallbackReason: actualLabel,
    };
  }

  // 3. Preferred planType, any optionType (prefer Growth if available).
  const planMatch = plans.filter((p) => p.planType === preferredPlan);
  if (planMatch.length > 0) {
    const withGrowth = planMatch.filter((p) => p.optionType === 'growth');
    const best = withGrowth.length > 0 ? withGrowth[0] : [...planMatch].sort(sortIdcw)[0];
    const optLabel = best.optionType === 'growth' ? 'Growth' : 'IDCW';
    return {
      schemeCode: best.schemeCode,
      planType: best.planType,
      optionType: best.optionType,
      isFallback: true,
      fallbackReason: `${optLabel}-only`,
    };
  }

  // 4. Any plan/option (last resort).
  const best = plans[0];
  return {
    schemeCode: best.schemeCode,
    planType: best.planType,
    optionType: best.optionType,
    isFallback: true,
    fallbackReason: 'Different plan available',
  };
}

// ---------------------------------------------------------------------------
// Column sets
// ---------------------------------------------------------------------------

const SEARCH_COLUMNS =
  'scheme_code, scheme_name, scheme_category, sebi_category, amc_name, plan_type, isin, scheme_active, openfolio_meta_synced_at';

const FAMILY_SEARCH_COLUMNS =
  'of_family_id, family_name, amc_name, sebi_category, scheme_category, has_direct, has_regular, has_growth, has_idcw, representative_scheme_code, family_active';

const FAMILY_PLANS_COLUMNS = 'scheme_code, plan_type, option_type';

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

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
    openfolioMetaSyncedAt: (row.openfolio_meta_synced_at as string | null) ?? null,
  };
}

function mapFamilyRow(row: Record<string, unknown>): FamilySearchResult {
  return {
    ofFamilyId: row.of_family_id as string,
    familyName: (row.family_name as string | null) ?? null,
    amcName: (row.amc_name as string | null) ?? null,
    sebiCategory: (row.sebi_category as string | null) ?? null,
    schemeCategory: (row.scheme_category as string | null) ?? null,
    hasDirect: (row.has_direct as boolean) ?? false,
    hasRegular: (row.has_regular as boolean) ?? false,
    hasGrowth: (row.has_growth as boolean) ?? false,
    hasIdcw: (row.has_idcw as boolean) ?? false,
    representativeSchemeCode: row.representative_scheme_code as number,
    familyActive: (row.family_active as boolean) ?? false,
  };
}

// ---------------------------------------------------------------------------
// Plan-level search (existing, used by Past SIP Check single-select)
// ---------------------------------------------------------------------------

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
 * Ordering: scheme_active DESC NULLS LAST (live first), then
 * openfolio_meta_synced_at DESC NULLS LAST (enriched first), then scheme_name
 * ASC. This surfaces live, well-curated schemes before historical shells and
 * unsynced rows (95% of the catalog).
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
    .order('openfolio_meta_synced_at', { ascending: false, nullsFirst: false })
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

// ---------------------------------------------------------------------------
// Family-level search (new — family-first picker §6.5)
// ---------------------------------------------------------------------------

export interface FamilySearchOptions {
  /** Free-text query — matched against family_name, sebi_category, amc_name. */
  query?: string;
  /** Pagination — first row offset (default 0). */
  offset?: number;
  /** Pagination — max rows returned (default 25). */
  limit?: number;
}

/**
 * Fetch a page of fund families from v_fund_family_search.
 *
 * One row per of_family_id (~2,046 active families vs ~8,347 plan rows).
 * Matching model mirrors searchSchemes: each token must match family_name OR
 * sebi_category OR amc_name (AND across tokens, OR across columns per token).
 *
 * Ordering (FL13): active families first, then enriched (max_synced_at DESC),
 * then alphabetical by family_name. Inactive/matured families are demoted but
 * not hidden — they appear after active ones.
 */
export async function searchFamilies(
  options: FamilySearchOptions = {},
): Promise<FamilySearchResult[]> {
  const { query = '', offset = 0, limit = 25 } = options;

  let q = schemeFamilySearchRepo
    .from()
    .select(FAMILY_SEARCH_COLUMNS)
    .order('family_active', { ascending: false, nullsFirst: false })
    .order('max_synced_at', { ascending: false, nullsFirst: false })
    .order('family_name', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  for (const token of tokenizeQuery(query)) {
    const safe = token.replace(/[(),*]/g, '');
    if (!safe) continue;
    q = q.or(
      `family_name.ilike.%${safe}%,sebi_category.ilike.%${safe}%,amc_name.ilike.%${safe}%`,
    );
  }

  const { data, error } = await q;
  if (error) throw new Error(`searchFamilies failed: ${error.message}`);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapFamilyRow);
}

/**
 * Fetch all plan/option variants for a fund family so the picker can resolve
 * to the right scheme_code client-side when the global toggle changes.
 *
 * Returns a small slice of scheme_master (typically 2–8 rows per family).
 */
export async function fetchFamilyPlans(ofFamilyId: string): Promise<FamilyPlan[]> {
  const { data, error } = await schemeMasterRepo
    .from()
    .select(FAMILY_PLANS_COLUMNS)
    .eq('of_family_id', ofFamilyId);
  if (error) throw new Error(`fetchFamilyPlans failed: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    schemeCode: row.scheme_code as number,
    planType: (row.plan_type as 'direct' | 'regular' | null) ?? null,
    optionType: (row.option_type as string | null) ?? null,
  }));
}

/**
 * Fetch the families the user currently holds (for the "Your funds" section
 * in the family-first picker). Deduplicates to one family per of_family_id.
 */
export async function fetchUserHeldFamilies(userId: string): Promise<FamilySearchResult[]> {
  // Step 1: get the user's held scheme codes.
  const { data: holdings, error: holdingsError } = await userFundRepo
    .from()
    .select('scheme_code')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (holdingsError) throw new Error(`fetchUserHeldFamilies (holdings) failed: ${holdingsError.message}`);
  const codes = [...new Set((holdings ?? []).map((r) => r.scheme_code as number))];
  if (codes.length === 0) return [];

  // Step 2: look up of_family_id for those codes.
  const { data: schemeRows, error: schemeError } = await schemeMasterRepo
    .from()
    .select('of_family_id')
    .in('scheme_code', codes)
    .not('of_family_id', 'is', null);
  if (schemeError) throw new Error(`fetchUserHeldFamilies (family_ids) failed: ${schemeError.message}`);

  const familyIds = [...new Set(
    ((schemeRows ?? []) as unknown as Record<string, unknown>[])
      .map((r) => r.of_family_id as string | null)
      .filter((id): id is string => id != null),
  )];
  if (familyIds.length === 0) return [];

  // Step 3: fetch full family rows for those family IDs.
  const { data, error } = await schemeFamilySearchRepo
    .from()
    .select(FAMILY_SEARCH_COLUMNS)
    .in('of_family_id', familyIds)
    .order('family_name', { ascending: true, nullsFirst: false });
  if (error) throw new Error(`fetchUserHeldFamilies (families) failed: ${error.message}`);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapFamilyRow);
}
