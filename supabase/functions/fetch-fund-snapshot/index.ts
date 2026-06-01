/**
 * fetch-fund-snapshot — on-demand metadata + composition hydration for one
 * scheme. Used by the Compare Funds screen when a user picks a fund nobody
 * else holds, so all six tabs render with real data instead of "—".
 *
 * Two stages, both idempotent + cache-aware:
 *
 *   1. scheme_master metadata (mirrors sync-fund-meta single-scheme path):
 *      - Fetches mfdata.in /schemes/{code}
 *      - Upserts launch_date, exit_load, expense_ratio, AUM, plan_type,
 *        family_name, amc_name, period_returns, risk_ratios, etc.
 *      - Skipped when fund_meta_synced_at < 7 days old.
 *
 *   2. fund_portfolio_composition (mirrors sync-fund-portfolios single-scheme):
 *      - Fetches /families/{family_id}/holdings
 *      - Builds composition with the same guards as the cron (corruption
 *        detection on debt_holdings, equity_pct plausibility check).
 *      - Upserts source='amfi' row dated last day of previous month.
 *      - Skipped when an amfi row exists for the current month.
 *
 * NAV history is NOT included — that's `fetch-fund-nav` (separate, larger
 * payload). The Compare screen invokes both in parallel.
 *
 * POST body: { scheme_code: number }
 * Response:  { scheme_code, meta_status, composition_status, ... }
 *
 * Deploy with --no-verify-jwt so the client can invoke without a user JWT.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEvent } from '../_shared/analytics.ts';
import {
  type CapClassification,
  type CategoryComposition,
  type EquityHolding,
  type MarketCapCategory,
  classifyHoldings,
  deriveDebtPct,
  isDebtDataCorrupted,
  isEquityHoldingsCorrupted,
  isEquityPctPlausible,
  deriveSchemeCategoryFromName,
  isGenericSchemeCategory,
} from '../_shared/portfolio-utils.ts';
import { isCachedMapStillValid } from '../_shared/amfi-xlsx-parser.ts';
import { isSchemeMetaFresh } from '../_shared/scheme-meta-cache.ts';
import {
  createOpenFolioClient,
  isPlausibleDisclosureDate,
  mapCompositionToRow,
  resolveOpenFolioCredentials,
} from '../_shared/openfolio.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MFDATA_BASE = 'https://mfdata.in/api/v1';
const MFDATA_USER_AGENT = 'Mozilla/5.0 (compatible; FundLens/1.0; +https://fundlens.app)';
const FETCH_TIMEOUT_MS = 12_000;
const MFAPI_BASE = 'https://api.mfapi.in/mf';

const META_STALE_DAYS = 7;

// ---------------------------------------------------------------------------
// Category rules (copy of sync-fund-portfolios — kept inline because Deno
// doesn't share modules cross-function and this file should be self-contained
// at ~250 lines for the read-once-per-pick path).
// ---------------------------------------------------------------------------

const CATEGORY_RULES: Record<string, CategoryComposition> = {
  'large cap fund':            { equity: 95, debt: 0,  cash: 5,  other: 0, large: 80, mid: 12, small: 8  },
  'mid cap fund':              { equity: 95, debt: 0,  cash: 5,  other: 0, large: 8,  mid: 75, small: 17 },
  'small cap fund':            { equity: 90, debt: 0,  cash: 10, other: 0, large: 5,  mid: 12, small: 83 },
  'multi cap fund':            { equity: 95, debt: 0,  cash: 5,  other: 0, large: 30, mid: 35, small: 35 },
  'flexi cap fund':            { equity: 93, debt: 0,  cash: 7,  other: 0, large: 38, mid: 33, small: 29 },
  'large & mid cap fund':      { equity: 95, debt: 0,  cash: 5,  other: 0, large: 50, mid: 40, small: 10 },
  'elss':                      { equity: 95, debt: 0,  cash: 5,  other: 0, large: 42, mid: 30, small: 28 },
  'value fund':                { equity: 93, debt: 0,  cash: 7,  other: 0, large: 65, mid: 22, small: 13 },
  'contra fund':               { equity: 93, debt: 0,  cash: 7,  other: 0, large: 60, mid: 25, small: 15 },
  'focused fund':              { equity: 92, debt: 0,  cash: 8,  other: 0, large: 55, mid: 25, small: 20 },
  'sectoral/thematic':         { equity: 95, debt: 0,  cash: 5,  other: 0, large: 50, mid: 30, small: 20 },
  'dividend yield fund':       { equity: 92, debt: 0,  cash: 8,  other: 0, large: 55, mid: 28, small: 17 },
  'aggressive hybrid fund':    { equity: 78, debt: 17, cash: 5,  other: 0, large: 48, mid: 28, small: 24 },
  'balanced hybrid fund':      { equity: 50, debt: 45, cash: 5,  other: 0, large: 55, mid: 28, small: 17 },
  'conservative hybrid fund':  { equity: 20, debt: 73, cash: 7,  other: 0, large: 60, mid: 25, small: 15 },
  'balanced advantage fund':   { equity: 55, debt: 35, cash: 10, other: 0, large: 55, mid: 28, small: 17 },
  'dynamic asset allocation':  { equity: 55, debt: 35, cash: 10, other: 0, large: 55, mid: 28, small: 17 },
  'multi asset allocation':    { equity: 50, debt: 30, cash: 10, other: 10, large: 50, mid: 28, small: 22 },
  'equity savings fund':       { equity: 35, debt: 45, cash: 20, other: 0, large: 60, mid: 25, small: 15 },
  'arbitrage fund':            { equity: 65, debt: 30, cash: 5,  other: 0, large: 75, mid: 20, small: 5  },
  'overnight fund':            { equity: 0,  debt: 5,  cash: 95, other: 0, large: 0,  mid: 0,  small: 0  },
  'liquid fund':               { equity: 0,  debt: 20, cash: 80, other: 0, large: 0,  mid: 0,  small: 0  },
  'ultra short duration fund': { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'low duration fund':         { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'money market fund':         { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'short duration fund':       { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'medium duration fund':      { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'medium to long duration':   { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'long duration fund':        { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'dynamic bond fund':         { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'corporate bond fund':       { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'credit risk fund':          { equity: 0,  debt: 90, cash: 10, other: 0, large: 0,  mid: 0,  small: 0  },
  'banking and psu fund':      { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'gilt fund':                 { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'floater fund':              { equity: 0,  debt: 92, cash: 8,  other: 0, large: 0,  mid: 0,  small: 0  },
  'index funds':               { equity: 95, debt: 0,  cash: 5,  other: 0, large: 90, mid: 8,  small: 2  },
  'other etfs':                { equity: 95, debt: 0,  cash: 5,  other: 0, large: 90, mid: 8,  small: 2  },
  'fund of funds investing overseas': { equity: 0, debt: 0, cash: 0, other: 100, large: 0, mid: 0, small: 0 },
  'fund of funds domestic':    { equity: 50, debt: 30, cash: 5,  other: 15, large: 45, mid: 25, small: 20 },
  'solution oriented - retirement': { equity: 80, debt: 15, cash: 5, other: 0, large: 50, mid: 28, small: 22 },
  'solution oriented - childrens': { equity: 70, debt: 25, cash: 5, other: 0, large: 50, mid: 28, small: 22 },
};

const GENERIC_CATEGORY_MAP: Record<string, CategoryComposition> = {
  'equity': { equity: 93, debt: 0,  cash: 7,  other: 0,   large: 38, mid: 33, small: 29 },
  'debt':   { equity: 0,  debt: 90, cash: 10, other: 0,   large: 0,  mid: 0,  small: 0  },
  'hybrid': { equity: 65, debt: 25, cash: 10, other: 0,   large: 48, mid: 28, small: 24 },
  'other':  { equity: 0,  debt: 0,  cash: 0,  other: 100, large: 0,  mid: 0,  small: 0  },
};

const FALLBACK_COMPOSITION: CategoryComposition = {
  equity: 80, debt: 10, cash: 10, other: 0,
  large: 50, mid: 30, small: 20,
};

function getCategoryRules(
  schemeCategory: string | null | undefined,
  schemeName?: string | null,
): CategoryComposition {
  // When AMFI/mfdata return the bare single-word "Equity" (or "Hybrid" /
  // "Debt" / "Other"), the legacy lookup landed on a flexi-cap proxy
  // (38/33/29) for every equity scheme. Resolving the sub-bucket from
  // scheme_name first rescues funds like DSP Mid Cap / Small Cap / Large
  // Cap / Large & Mid Cap before they fall through to the proxy.
  if (isGenericSchemeCategory(schemeCategory)) {
    const derivedKey = deriveSchemeCategoryFromName(schemeName);
    if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
  }

  if (!schemeCategory) {
    const derivedKey = deriveSchemeCategoryFromName(schemeName);
    if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
    return FALLBACK_COMPOSITION;
  }
  const key = schemeCategory.toLowerCase().trim();
  if (CATEGORY_RULES[key]) return CATEGORY_RULES[key];
  if (GENERIC_CATEGORY_MAP[key]) {
    const derivedKey = deriveSchemeCategoryFromName(schemeName);
    if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
    return GENERIC_CATEGORY_MAP[key];
  }
  if (key.split(' ').length >= 2) {
    for (const [pattern, comp] of Object.entries(CATEGORY_RULES)) {
      if (key.includes(pattern) || pattern.includes(key.split(' ').slice(0, 3).join(' '))) {
        return comp;
      }
    }
  }
  const derivedKey = deriveSchemeCategoryFromName(schemeName);
  if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
  return FALLBACK_COMPOSITION;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MFDataSchemePayload {
  family_id?: number | null;
  isin?: string | null;
  expense_ratio?: number | null;
  morningstar?: number | null;
  risk_label?: string | null;
  aum?: number | null;
  min_sip?: number | null;
  min_lumpsum?: number | null;
  min_additional?: number | null;
  exit_load?: string | null;
  launch_date?: string | null;
  plan_type?: string | null;
  option_type?: string | null;
  family_name?: string | null;
  amc_name?: string | null;
  amc_slug?: string | null;
  category?: string | null;
  benchmark?: string | null;
  related_variants?: unknown[] | null;
  returns?: Record<string, unknown> | null;
  ratios?: Record<string, unknown> | null;
}

interface MfdataEquityHolding {
  stock_name?: string;
  isin?: string | null;
  sector?: string | null;
  weight_pct?: number;
}

interface MfdataDebtHolding {
  name?: string;
  credit_rating?: string;
  maturity_date?: string | null;
  holding_type?: string;
  market_value?: number | null;
  weight_pct?: number;
}

interface MfdataHoldings {
  equity_pct?: number;
  debt_pct?: number;
  other_pct?: number;
  equity_holdings?: MfdataEquityHolding[];
  debt_holdings?: MfdataDebtHolding[];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function mfdataGet<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${MFDATA_BASE}${path}`, {
      signal: controller.signal,
      headers: { 'User-Agent': MFDATA_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn('[fetch-fund-snapshot] mfdata %s → %d', path, res.status);
      return null;
    }
    const body = await res.json() as { data?: T };
    return body?.data ?? (body as unknown as T) ?? null;
  } catch (err) {
    console.warn('[fetch-fund-snapshot] mfdata %s failed: %s', path, String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMfapiIsin(schemeCode: number): Promise<string | null> {
  try {
    const res = await fetch(`${MFAPI_BASE}/${schemeCode}`);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.meta?.isin_growth ?? null;
  } catch {
    return null;
  }
}

function toCrores(amount: number | null | undefined): number | null {
  if (amount == null || Number.isNaN(amount)) return null;
  return Math.round((amount / 10_000_000) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Stage 1 — scheme_master metadata
// ---------------------------------------------------------------------------

interface MetaResult {
  status: 'fetched' | 'cache_hit' | 'failed';
  family_id?: number | null;
  scheme_category?: string | null;
  scheme_name?: string | null;
}

async function syncMeta(schemeCode: number): Promise<MetaResult> {
  // Cache check. scheme_name is pulled so generic categories like
  // "Equity" can be resolved into a SEBI sub-bucket downstream.
  const { data: existing } = await supabase
    .from('scheme_master')
    .select('fund_meta_synced_at, mfdata_family_id, scheme_category, scheme_name')
    .eq('scheme_code', schemeCode)
    .maybeSingle();

  // `isSchemeMetaFresh` requires both a recent timestamp AND a non-null
  // `mfdata_family_id`. Without the family_id guard, a previous partial-
  // success sync (mfdata down, mfapi-only) would lock the cache for 7
  // days and the holdings path would fall back to category defaults
  // (audit #6). See `_shared/scheme-meta-cache.ts`.
  if (isSchemeMetaFresh(existing, META_STALE_DAYS)) {
    const ageMs = Date.now() - new Date(existing!.fund_meta_synced_at!).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    console.log('[fetch-fund-snapshot] scheme=%d meta cache hit (age=%.1fd)', schemeCode, ageDays);
    return {
      status: 'cache_hit',
      family_id: (existing!.mfdata_family_id as number | null) ?? null,
      scheme_category: existing!.scheme_category as string | null,
      scheme_name: (existing!.scheme_name as string | null) ?? null,
    };
  }

  const mfdata = await mfdataGet<MFDataSchemePayload>(`/schemes/${schemeCode}`);
  let isin: string | null = mfdata?.isin ?? null;
  if (!isin) isin = await fetchMfapiIsin(schemeCode);

  if (!mfdata && !isin) {
    console.warn('[fetch-fund-snapshot] scheme=%d nothing from mfdata or mfapi', schemeCode);
    return { status: 'failed' };
  }

  const expense_ratio = mfdata?.expense_ratio != null ? Number(mfdata.expense_ratio) : null;
  const aum_cr = toCrores(mfdata?.aum ?? null);
  const min_sip_amount = mfdata?.min_sip != null ? Math.round(Number(mfdata.min_sip)) : null;
  const min_lumpsum = mfdata?.min_lumpsum != null ? Math.round(Number(mfdata.min_lumpsum)) : null;
  const min_additional = mfdata?.min_additional != null ? Math.round(Number(mfdata.min_additional)) : null;
  const morningstar_rating = mfdata?.morningstar != null ? Math.round(Number(mfdata.morningstar)) : null;
  const launch_date = typeof mfdata?.launch_date === 'string' && mfdata.launch_date.trim().length > 0
    ? mfdata.launch_date.trim()
    : null;

  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    fund_meta_synced_at: now,
  };

  if (isin) payload.isin = isin;
  if (expense_ratio != null) payload.expense_ratio = expense_ratio;
  if (aum_cr != null) payload.aum_cr = aum_cr;
  if (min_sip_amount != null) payload.min_sip_amount = min_sip_amount;
  if (min_lumpsum != null) payload.min_lumpsum = min_lumpsum;
  if (min_additional != null) payload.min_additional = min_additional;
  if (launch_date) payload.launch_date = launch_date;

  if (mfdata) {
    payload.mfdata_family_id = mfdata.family_id ?? null;
    payload.declared_benchmark_name = mfdata.benchmark ?? null;
    payload.risk_label = mfdata.risk_label ?? null;
    payload.morningstar_rating = morningstar_rating;
    payload.related_variants = mfdata.related_variants ?? null;
    payload.mfdata_meta_synced_at = now;
    payload.exit_load = mfdata.exit_load ?? null;
    payload.plan_type = mfdata.plan_type ?? null;
    payload.option_type = mfdata.option_type ?? null;
    payload.family_name = mfdata.family_name ?? null;
    payload.amc_name = mfdata.amc_name ?? null;
    payload.amc_slug = mfdata.amc_slug ?? null;
    payload.period_returns = mfdata.returns ?? null;
    payload.risk_ratios = mfdata.ratios ?? null;
    if (mfdata.category && !existing?.scheme_category) {
      // Only set scheme_category when scheme_master doesn't already have one,
      // so we don't overwrite a richer cron-set value.
      payload.scheme_category = mfdata.category;
    }
  }

  const { error } = await supabase.from('scheme_master').update(payload).eq('scheme_code', schemeCode);
  if (error) {
    console.error('[fetch-fund-snapshot] scheme=%d meta update error: %s', schemeCode, error.message);
    return { status: 'failed' };
  }

  console.log('[fetch-fund-snapshot] scheme=%d meta updated', schemeCode);
  return {
    status: 'fetched',
    family_id: mfdata?.family_id ?? null,
    scheme_category: mfdata?.category ?? existing?.scheme_category ?? null,
    scheme_name: (existing?.scheme_name as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — fund_portfolio_composition
// ---------------------------------------------------------------------------

interface CompositionResult {
  status: 'fetched' | 'cache_hit' | 'category_rules' | 'no_holdings' | 'failed';
  classifierOutcome: 'official' | 'amfi' | 'category_fallback' | 'category_rules' | null;
  classifierCoveragePct: number | null;
  equityHoldingsCount: number;
}

/**
 * Official-first: try OpenFolio-Data for this exact AMFI scheme_code before
 * falling back to mfdata/category. Returns the upserted result, or null when
 * OpenFolio is unconfigured / has no snapshot / errored — the caller then
 * proceeds to the existing mfdata path. Never throws.
 */
const OFFICIAL_STALE_DAYS = 35;

async function syncOfficialComposition(schemeCode: number): Promise<CompositionResult | null> {
  // Recency cache: an 'official' row is refreshed monthly, so a row synced in
  // the last 35 days is fresh. This guards against re-hitting OpenFolio on
  // every fund pick (official rows are dated to the prior month-end, so the
  // caller's current-month gate won't recognise them as cached).
  const { data: existingOfficial } = await supabase
    .from('fund_portfolio_composition')
    .select('portfolio_date, synced_at')
    .eq('scheme_code', schemeCode)
    .eq('source', 'official')
    .order('portfolio_date', { ascending: false })
    .limit(1);
  if (existingOfficial && existingOfficial.length > 0) {
    const syncedAtMs = new Date(existingOfficial[0].synced_at as string).getTime();
    if (Number.isFinite(syncedAtMs) && Date.now() - syncedAtMs < OFFICIAL_STALE_DAYS * 86_400_000) {
      console.log('[fetch-fund-snapshot] scheme=%d official cache hit (%s)', schemeCode, existingOfficial[0].portfolio_date);
      return { status: 'cache_hit', classifierOutcome: 'official', classifierCoveragePct: null, equityHoldingsCount: 0 };
    }
  }

  let client: ReturnType<typeof createOpenFolioClient>;
  try {
    client = createOpenFolioClient(resolveOpenFolioCredentials(Deno.env));
  } catch (err) {
    console.warn('[fetch-fund-snapshot] scheme=%d OpenFolio not configured: %s', schemeCode, String(err));
    return null;
  }

  let composition;
  try {
    composition = await client.getComposition(schemeCode, { top: 50 });
  } catch (err) {
    console.warn('[fetch-fund-snapshot] scheme=%d OpenFolio fetch failed: %s', schemeCode, String(err));
    return null;
  }
  if (!composition) {
    console.log('[fetch-fund-snapshot] scheme=%d no OpenFolio snapshot, falling back', schemeCode);
    return null;
  }

  if (!isPlausibleDisclosureDate(composition.disclosure_date, new Date().getFullYear())) {
    console.warn(
      '[fetch-fund-snapshot] scheme=%d implausible OpenFolio disclosure_date=%s, falling back',
      schemeCode, composition.disclosure_date,
    );
    return null;
  }

  const row = mapCompositionToRow(composition, schemeCode, new Date().toISOString());
  const { error } = await supabase
    .from('fund_portfolio_composition')
    .upsert(row, { onConflict: 'scheme_code,portfolio_date,source' });
  if (error) {
    console.error('[fetch-fund-snapshot] scheme=%d official upsert error: %s', schemeCode, error.message);
    return { status: 'failed', classifierOutcome: null, classifierCoveragePct: null, equityHoldingsCount: 0 };
  }

  console.log('[fetch-fund-snapshot] scheme=%d official composition upserted (date=%s)', schemeCode, row.portfolio_date);
  return {
    status: 'fetched',
    classifierOutcome: 'official',
    classifierCoveragePct: null,
    equityHoldingsCount: row.top_holdings?.length ?? 0,
  };
}

async function syncComposition(
  schemeCode: number,
  familyId: number | null,
  schemeCategory: string | null,
  schemeName: string | null,
  isinToCap: Map<string, MarketCapCategory>,
): Promise<CompositionResult> {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

  // Cache check — current-month real-holdings row already present ('official',
  // a classifier hit, or a category_fallback). category_rules never short-
  // circuits the lookup, because it's the last-resort path.
  const { data: existing } = await supabase
    .from('fund_portfolio_composition')
    .select('source, portfolio_date')
    .eq('scheme_code', schemeCode)
    .gte('portfolio_date', currentMonthStart)
    .in('source', ['official', 'amfi', 'category_fallback'])
    .limit(1);

  if (existing && existing.length > 0) {
    console.log('[fetch-fund-snapshot] scheme=%d composition cache hit (%s, %s)',
      schemeCode, existing[0].portfolio_date, existing[0].source);
    return {
      status: 'cache_hit',
      classifierOutcome: existing[0].source as 'official' | 'amfi' | 'category_fallback',
      classifierCoveragePct: null,
      equityHoldingsCount: 0,
    };
  }

  // Official-first: OpenFolio-Data is the primary source. If it has a snapshot
  // for this scheme, upsert it and we're done — mfdata is only the backup.
  const official = await syncOfficialComposition(schemeCode);
  if (official) return official;

  // No family_id → fall back to category rules.
  if (familyId == null) {
    const res = await seedCategoryRules(schemeCode, schemeCategory, schemeName);
    return { ...res, classifierOutcome: 'category_rules', classifierCoveragePct: null, equityHoldingsCount: 0 };
  }

  const holdings = await mfdataGet<MfdataHoldings>(`/families/${familyId}/holdings`);
  if (!holdings || !holdings.equity_holdings || holdings.equity_holdings.length === 0) {
    const res = await seedCategoryRules(schemeCode, schemeCategory, schemeName);
    return { ...res, classifierOutcome: 'category_rules', classifierCoveragePct: null, equityHoldingsCount: 0 };
  }

  const portfolio = buildPortfolio(holdings, schemeCategory ?? '', schemeName, isinToCap);
  const portfolioDate = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

  const sourceTag = portfolio.classifierOutcome === 'amfi' ? 'amfi' : 'category_fallback';

  const { error } = await supabase.from('fund_portfolio_composition').upsert({
    scheme_code: schemeCode,
    portfolio_date: portfolioDate,
    equity_pct: portfolio.equityPct,
    debt_pct: portfolio.debtPct,
    cash_pct: portfolio.cashPct,
    other_pct: portfolio.otherPct,
    large_cap_pct: portfolio.largeCapPct,
    mid_cap_pct: portfolio.midCapPct,
    small_cap_pct: portfolio.smallCapPct,
    not_classified_pct: portfolio.notClassifiedPct,
    sector_allocation: portfolio.sectorAllocation,
    top_holdings: portfolio.topHoldings,
    raw_debt_holdings: portfolio.rawDebtHoldings,
    source: sourceTag,
    synced_at: new Date().toISOString(),
  }, { onConflict: 'scheme_code,portfolio_date,source' });

  if (error) {
    console.error('[fetch-fund-snapshot] scheme=%d composition upsert error: %s', schemeCode, error.message);
    return {
      status: 'failed',
      classifierOutcome: null,
      classifierCoveragePct: portfolio.classifierCoveragePct,
      equityHoldingsCount: holdings.equity_holdings.length,
    };
  }

  console.log('[fetch-fund-snapshot] scheme=%d composition fetched (%s, coverage=%s%%)',
    schemeCode, sourceTag, portfolio.classifierCoveragePct);
  return {
    status: 'fetched',
    classifierOutcome: portfolio.classifierOutcome,
    classifierCoveragePct: portfolio.classifierCoveragePct,
    equityHoldingsCount: holdings.equity_holdings.length,
  };
}

async function seedCategoryRules(
  schemeCode: number,
  schemeCategory: string | null,
  schemeName: string | null,
): Promise<{ status: 'category_rules' | 'failed' }> {
  const today = new Date().toISOString().split('T')[0];
  const comp = getCategoryRules(schemeCategory, schemeName);
  const notClassified = Math.max(0, 100 - comp.large - comp.mid - comp.small);

  const { error } = await supabase.from('fund_portfolio_composition').upsert({
    scheme_code: schemeCode,
    portfolio_date: today,
    equity_pct: comp.equity,
    debt_pct: comp.debt,
    cash_pct: comp.cash,
    other_pct: comp.other,
    large_cap_pct: comp.large,
    mid_cap_pct: comp.mid,
    small_cap_pct: comp.small,
    not_classified_pct: notClassified,
    sector_allocation: null,
    top_holdings: null,
    raw_debt_holdings: null,
    source: 'category_rules',
    synced_at: new Date().toISOString(),
  }, { onConflict: 'scheme_code,portfolio_date,source', ignoreDuplicates: true });

  if (error) {
    console.error('[fetch-fund-snapshot] scheme=%d category-rules seed error: %s', schemeCode, error.message);
    return { status: 'failed' };
  }
  console.log('[fetch-fund-snapshot] scheme=%d category_rules seeded', schemeCode);
  return { status: 'category_rules' };
}

interface BuiltPortfolio {
  equityPct: number; debtPct: number; cashPct: number; otherPct: number;
  largeCapPct: number; midCapPct: number; smallCapPct: number;
  notClassifiedPct: number;
  /** 'amfi' if ≥1 ISIN classified; 'category_fallback' if had holdings but none matched. */
  classifierOutcome: 'amfi' | 'category_fallback';
  /** How many of the 50 disclosed top-holdings rows were classified into L/M/S. */
  classifierHits: number;
  /** Sum of largeCapPct + midCapPct + smallCapPct — coverage as a % of NAV. */
  classifierCoveragePct: number;
  sectorAllocation: Record<string, number> | null;
  topHoldings: { name: string; isin: string; sector: string; marketCap: string; pctOfNav: number }[] | null;
  rawDebtHoldings: MfdataDebtHolding[] | null;
}

function buildPortfolio(
  holdings: MfdataHoldings,
  schemeCategory: string,
  schemeName: string | null,
  isinToCap: Map<string, MarketCapCategory>,
): BuiltPortfolio {
  const catRules = getCategoryRules(schemeCategory, schemeName);

  const rawEquityPct = holdings.equity_pct;
  const equityPctValid = typeof rawEquityPct === 'number' && isEquityPctPlausible(rawEquityPct, catRules);
  if (typeof rawEquityPct === 'number' && !equityPctValid) {
    console.warn('[fetch-fund-snapshot] equity_pct %s implausible for %s, falling back', rawEquityPct, schemeCategory);
  }
  const equityPct = equityPctValid ? rawEquityPct! : catRules.equity;

  const debtHoldings = holdings.debt_holdings ?? [];
  let debtPct: number;
  let rawDebtHoldings: MfdataDebtHolding[] | null = null;
  if (debtHoldings.length > 0) {
    if (isDebtDataCorrupted(debtHoldings)) {
      debtPct = Math.min(catRules.debt, Math.max(0, 100 - equityPct));
    } else {
      const derived = deriveDebtPct(debtHoldings);
      debtPct = derived > 0 ? Math.round(derived * 100) / 100 : Math.min(catRules.debt, Math.max(0, 100 - equityPct));
      rawDebtHoldings = debtHoldings;
    }
  } else {
    debtPct = Math.min(catRules.debt, Math.max(0, 100 - equityPct));
  }

  const cashPct = Math.max(0, 100 - equityPct - debtPct);

  // Reject equity_holdings outright if it's been polluted with benchmark
  // rows — sector aggregation and the classifier both join over every entry.
  const rawEquityHoldings = holdings.equity_holdings ?? [];
  let equityHoldings: MfdataEquityHolding[];
  if (isEquityHoldingsCorrupted(rawEquityHoldings as EquityHolding[])) {
    console.warn(
      '[fetch-fund-snapshot] equity_holdings corrupted for category "%s", discarding %d rows',
      schemeCategory, rawEquityHoldings.length,
    );
    equityHoldings = [];
  } else {
    equityHoldings = rawEquityHoldings;
  }

  const sectorMap: Record<string, number> = {};
  for (const h of equityHoldings) {
    if (h.sector && typeof h.weight_pct === 'number') {
      sectorMap[h.sector] = (sectorMap[h.sector] ?? 0) + h.weight_pct;
    }
  }
  const sectorAllocation: Record<string, number> = {};
  for (const [sector, weight] of Object.entries(sectorMap).sort(([, a], [, b]) => b - a)) {
    sectorAllocation[sector] = Math.round(weight * 100) / 100;
  }

  // Real per-fund cap split from the AMFI classifier — same shape as in
  // sync-fund-portfolios. Falls back to category defaults only when no
  // ISIN resolved; the caller flips `source` to 'category_fallback' so the
  // UI can show a disclaimer rather than presenting category-averages
  // as measured.
  const classification: CapClassification = classifyHoldings(
    equityHoldings as EquityHolding[],
    isinToCap,
  );
  const classifierTotal =
    classification.largeCapPct + classification.midCapPct + classification.smallCapPct;
  const hasClassifierCoverage = equityHoldings.length > 0 && classifierTotal > 0;

  const largeCapPct = hasClassifierCoverage ? classification.largeCapPct : catRules.large;
  const midCapPct = hasClassifierCoverage ? classification.midCapPct : catRules.mid;
  const smallCapPct = hasClassifierCoverage ? classification.smallCapPct : catRules.small;
  const notClassifiedPct = hasClassifierCoverage
    ? classification.notClassifiedPct
    : Math.max(0, 100 - catRules.large - catRules.mid - catRules.small);

  const annotatedByKey = new Map<string, MarketCapCategory | 'Other'>();
  for (const a of classification.annotated) {
    annotatedByKey.set(`${(a.isin ?? '').toUpperCase()}|${a.stock_name ?? ''}`, a.marketCap);
  }
  const topHoldings = equityHoldings
    .filter((h) => h.stock_name && typeof h.weight_pct === 'number')
    .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))
    .slice(0, 50)
    .map((h) => ({
      name: h.stock_name!,
      isin: h.isin ?? '',
      sector: h.sector ?? 'Other',
      marketCap: annotatedByKey.get(`${(h.isin ?? '').toUpperCase()}|${h.stock_name ?? ''}`) ?? 'Other',
      pctOfNav: h.weight_pct!,
    }));

  const classifierHits = classification.annotated.filter((a) => a.marketCap !== 'Other').length;

  return {
    equityPct: Math.round(equityPct * 100) / 100,
    debtPct: Math.round(debtPct * 100) / 100,
    cashPct: Math.round(cashPct * 100) / 100,
    otherPct: 0,
    largeCapPct,
    midCapPct,
    smallCapPct,
    notClassifiedPct,
    classifierOutcome: hasClassifierCoverage ? 'amfi' : 'category_fallback',
    classifierHits,
    classifierCoveragePct: Math.round(classifierTotal * 100) / 100,
    sectorAllocation: Object.keys(sectorAllocation).length > 0 ? sectorAllocation : null,
    topHoldings: topHoldings.length > 0 ? topHoldings : null,
    rawDebtHoldings,
  };
}

// ---------------------------------------------------------------------------
// Classifier cache
// ---------------------------------------------------------------------------

// Module-scope cache for the stock_market_cap table (~5400 rows). Edge
// function isolates are reused across warm invocations, so loading the
// table once per cold-start is the cheapest correct option. TTL is 6
// hours since the seeder cron is monthly.
//
// `isCachedMapStillValid` (in _shared/amfi-xlsx-parser.ts) refuses to
// reuse an empty cached map — that path covers the bootstrap race where
// this function got warm-started before `sync-stock-market-cap` had ever
// populated the table. Without that, an early invocation would cache the
// empty SELECT result and serve it for the next 6 hours, silently making
// the classifier fall back to SEBI category defaults on every fund.
const CAP_MAP_TTL_MS = 6 * 60 * 60 * 1000;
let cachedIsinToCap: Map<string, MarketCapCategory> | null = null;
let cachedIsinToCapAt = 0;

async function getIsinToCapMap(): Promise<Map<string, MarketCapCategory>> {
  const now = Date.now();
  if (isCachedMapStillValid(cachedIsinToCap, cachedIsinToCapAt, now, CAP_MAP_TTL_MS)) {
    return cachedIsinToCap!;
  }
  const map = new Map<string, MarketCapCategory>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('stock_market_cap')
      .select('isin, market_cap_category')
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn('[fetch-fund-snapshot] stock_market_cap load failed: %s', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data as { isin: string; market_cap_category: MarketCapCategory }[]) {
      map.set(row.isin.toUpperCase(), row.market_cap_category);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  // Only persist the cache when the load actually returned rows. An
  // empty result is treated as "not yet loaded" so the next call retries
  // — see `isCachedMapStillValid` for the full rationale.
  if (map.size > 0) {
    cachedIsinToCap = map;
    cachedIsinToCapAt = now;
  } else {
    console.warn('[fetch-fund-snapshot] stock_market_cap returned 0 rows; not caching, will retry next call');
  }
  return map;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  let schemeCode: number;
  try {
    const body = await req.json();
    const code = Number(body?.scheme_code);
    if (!Number.isFinite(code) || code <= 0) throw new Error('invalid scheme_code');
    schemeCode = code;
  } catch (err) {
    return json({ error: `bad request: ${String(err)}` }, { status: 400 });
  }

  const startedAt = Date.now();
  console.log('[fetch-fund-snapshot] scheme=%d invocation started', schemeCode);

  const isinToCap = await getIsinToCapMap();

  // Stage 1 — metadata.
  const metaResult = await syncMeta(schemeCode);

  // Stage 2 — composition. Always attempt, even if meta failed (a fund could
  // already have scheme_master row from the AMFI seed but no composition).
  let compositionResult: CompositionResult;
  if (metaResult.status === 'failed') {
    // Best-effort composition with category fallback only — we don't have a
    // family_id and may not have a category either. Even when meta failed
    // we may still have scheme_master.scheme_name from a prior AMFI seed,
    // so pull it directly here for the name-based sub-bucket rescue.
    const { data: fallbackName } = await supabase
      .from('scheme_master')
      .select('scheme_name')
      .eq('scheme_code', schemeCode)
      .maybeSingle();
    compositionResult = await syncComposition(
      schemeCode,
      null,
      null,
      (fallbackName?.scheme_name as string | null) ?? null,
      isinToCap,
    );
  } else {
    compositionResult = await syncComposition(
      schemeCode,
      metaResult.family_id ?? null,
      metaResult.scheme_category ?? null,
      metaResult.scheme_name ?? null,
      isinToCap,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    '[fetch-fund-snapshot] scheme=%d done — meta=%s composition=%s elapsed_ms=%d',
    schemeCode, metaResult.status, compositionResult.status, elapsedMs,
  );

  trackServerEvent(
    'fund_snapshot_fetched',
    {
      scheme_code: schemeCode,
      composition_status: compositionResult.status,
      classifier_outcome: compositionResult.classifierOutcome,
      classifier_coverage_pct: compositionResult.classifierCoveragePct,
      equity_holdings_count: compositionResult.equityHoldingsCount,
      cap_map_size: isinToCap.size,
      elapsed_ms: elapsedMs,
    },
    'system:fetch-fund-snapshot',
  );

  return json({
    scheme_code: schemeCode,
    meta_status: metaResult.status,
    composition_status: compositionResult.status,
    elapsed_ms: elapsedMs,
  });
});
