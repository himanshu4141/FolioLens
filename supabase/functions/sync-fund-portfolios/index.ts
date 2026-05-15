/**
 * sync-fund-portfolios — builds portfolio composition data for all active funds.
 *
 * Two-layer strategy:
 *   Layer 1 (category_rules): Instant approximation derived from SEBI's fund
 *     categorisation framework — works with zero external calls, always succeeds.
 *   Layer 2 (amfi): Richer monthly holdings data sourced via mfdata.in, exposing
 *     real sector allocation and individual stock holdings.
 *
 * Resilience design:
 *   - Per-scheme errors are isolated — one failed lookup never blocks others.
 *   - AbortController (10 s) per HTTP fetch prevents hanging.
 *   - Single retry (2 s delay) for transient 5xx / 429 responses.
 *   - Idempotent upserts — safe to re-run at any time.
 *   - category_rules always seeded last — Insights screen is never empty even if
 *     all richer-data fetches fail.
 *
 * Trigger: HTTP POST (on-demand from app) or monthly cron / workflow.
 * Deploy with --no-verify-jwt so the app can invoke without user JWT.
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';
import {
  type CategoryComposition,
  type EquityHolding,
  type MarketCapCategory,
  type CapClassification,
  classifyHoldings,
  isDebtDataCorrupted,
  deriveDebtPct,
  isEquityHoldingsCorrupted,
  isEquityPctPlausible,
  isNumericString,
} from '../_shared/portfolio-utils.ts';
import { shouldSkipHoldingsSyncForEmptyClassifier } from '../_shared/amfi-xlsx-parser.ts';

const FETCH_TIMEOUT_MS = 10_000;
const REQUEST_DELAY_MS = 300; // stay well within mfdata.in rate limits
const MFDATA_BASE = 'https://mfdata.in/api/v1';

// ---------------------------------------------------------------------------
// SEBI category → approximate composition (regulatory minimum exposures)
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
  // Debt categories
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
  // FoF / passive
  'index funds':               { equity: 95, debt: 0,  cash: 5,  other: 0, large: 90, mid: 8,  small: 2  },
  'other etfs':                { equity: 95, debt: 0,  cash: 5,  other: 0, large: 90, mid: 8,  small: 2  },
  'fund of funds investing overseas': { equity: 0, debt: 0, cash: 0, other: 100, large: 0, mid: 0, small: 0 },
  'fund of funds domestic':    { equity: 50, debt: 30, cash: 5,  other: 15, large: 45, mid: 25, small: 20 },
  'solution oriented - retirement': { equity: 80, debt: 15, cash: 5, other: 0, large: 50, mid: 28, small: 22 },
  'solution oriented - childrens': { equity: 70, debt: 25, cash: 5, other: 0, large: 50, mid: 28, small: 22 },
};

// Generic single-word categories that AMFI sometimes uses — map to reasonable defaults
const GENERIC_CATEGORY_MAP: Record<string, CategoryComposition> = {
  'equity': { equity: 93, debt: 0,  cash: 7,  other: 0,   large: 38, mid: 33, small: 29 }, // flexi cap proxy
  'debt':   { equity: 0,  debt: 90, cash: 10, other: 0,   large: 0,  mid: 0,  small: 0  },
  'hybrid': { equity: 65, debt: 25, cash: 10, other: 0,   large: 48, mid: 28, small: 24 },
  'other':  { equity: 0,  debt: 0,  cash: 0,  other: 100, large: 0,  mid: 0,  small: 0  },
};

const FALLBACK_COMPOSITION: CategoryComposition = {
  equity: 80, debt: 10, cash: 10, other: 0,
  large: 50, mid: 30, small: 20,
};

function getCategoryRules(schemeCategory: string): CategoryComposition {
  const key = schemeCategory.toLowerCase().trim();
  if (CATEGORY_RULES[key]) return CATEGORY_RULES[key];
  if (GENERIC_CATEGORY_MAP[key]) return GENERIC_CATEGORY_MAP[key];
  // Partial match: only fire when the key has 2+ words to avoid 'equity' matching 'equity savings fund'
  if (key.split(' ').length >= 2) {
    for (const [pattern, comp] of Object.entries(CATEGORY_RULES)) {
      if (key.includes(pattern) || pattern.includes(key.split(' ').slice(0, 3).join(' '))) {
        return comp;
      }
    }
  }
  return FALLBACK_COMPOSITION;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A5: single retry with 2 s delay for transient 5xx / 429 errors
async function fetchJson(url: string, retries = 1): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'FundLens/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    const isRetryable = err instanceof Error &&
      (err.message.startsWith('HTTP 5') || err.message === 'HTTP 429');
    if (retries > 0 && isRetryable) {
      clearTimeout(timer);
      await delay(2000);
      return fetchJson(url, retries - 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface MfdataSchemeInfo {
  family_id?: number;
}

interface MfdataEquityHolding {
  stock_name?: string;
  isin?: string | null;
  sector?: string | null;
  weight_pct?: number;
}

// A1: actual field names confirmed by live probe (scripts/mfdata-probe*.sh, 2026-04-27)
// Valid holding_type codes — debt: B, BT, BD, CD, CP, BY
//                           — other: FO, DG, CQ, EP, CA, C, EX
// Numeric strings (e.g. "-18.07", "23.23") as holding_type signal data corruption.
interface MfdataDebtHolding {
  name?: string;
  credit_rating?: string;
  maturity_date?: string | null;
  holding_type?: string;
  market_value?: number | null;
  weight_pct?: number;
  quantity?: number | null;
  month_change_qty?: number | null;
  month_change_pct?: number | null;
}

type MfdataOtherHolding = MfdataDebtHolding;

interface MfdataHoldings {
  equity_pct?: number;
  debt_pct?: number;
  other_pct?: number;
  equity_holdings?: MfdataEquityHolding[];
  debt_holdings?: MfdataDebtHolding[];
  other_holdings?: MfdataOtherHolding[];
}

async function getSchemeInfo(schemeCode: number): Promise<MfdataSchemeInfo | null> {
  const data = await fetchJson(`${MFDATA_BASE}/schemes/${schemeCode}`) as { data?: MfdataSchemeInfo };
  return data?.data ?? null;
}

async function getFamilyHoldings(familyId: number): Promise<MfdataHoldings | null> {
  const data = await fetchJson(`${MFDATA_BASE}/families/${familyId}/holdings`) as { data?: MfdataHoldings };
  return data?.data ?? null;
}

interface EnrichedPortfolio {
  equityPct: number;
  debtPct: number;
  cashPct: number;
  otherPct: number;
  largeCapPct: number;
  midCapPct: number;
  smallCapPct: number;
  notClassifiedPct: number;
  /**
   * 'amfi' when at least one equity holding resolved to a Large/Mid/Small cap
   * via the classifier. 'category_fallback' when we had clean equity
   * holdings but none matched the AMFI list (e.g. an all-foreign-equity
   * fund or an out-of-date AMFI map). The caller chooses what source value
   * to persist; this field reports what the classifier produced.
   */
  classifierOutcome: 'amfi' | 'category_fallback';
  /** Number of equity_holdings rows we actually classified into L/M/S. */
  classifierHits: number;
  /** Number of equity_holdings rows that flowed into Not Classified. */
  classifierMisses: number;
  sectorAllocation: Record<string, number> | null;
  topHoldings: Array<{
    name: string;
    isin: string;
    sector: string;
    marketCap: string;
    pctOfNav: number;
  }> | null;
  rawDebtHoldings: MfdataDebtHolding[] | null;
}

function buildPortfolioFromHoldings(
  holdings: MfdataHoldings,
  schemeCategory: string,
  isinToCap: Map<string, MarketCapCategory>,
): EnrichedPortfolio {
  const catRules = getCategoryRules(schemeCategory);

  // A3: validate equity_pct before trusting it
  const rawEquityPct = holdings.equity_pct;
  const equityPctValid = typeof rawEquityPct === 'number' && isEquityPctPlausible(rawEquityPct, catRules);
  if (typeof rawEquityPct === 'number' && !equityPctValid) {
    console.warn(
      '[sync-fund-portfolios] equity_pct %.2f implausible for category "%s", falling back to rules',
      rawEquityPct, schemeCategory,
    );
  }
  const equityPct = equityPctValid ? rawEquityPct! : catRules.equity;

  // A1: derive debt_pct from actual debt_holdings (guard against corrupted arrays)
  const debtHoldings = holdings.debt_holdings ?? [];
  let debtPct: number;
  let rawDebtHoldings: MfdataDebtHolding[] | null = null;

  if (debtHoldings.length > 0) {
    if (isDebtDataCorrupted(debtHoldings)) {
      console.warn(
        '[sync-fund-portfolios] debt_holdings corrupted for category "%s", falling back to rules',
        schemeCategory,
      );
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
  const otherPct = 0;

  // Reject equity_holdings outright if it's been polluted with benchmark
  // rows — sector aggregation sums every row and the classifier joins by
  // ISIN, so even one bad entry can corrupt both downstream outputs.
  const rawEquityHoldings = holdings.equity_holdings ?? [];
  let equityHoldings: MfdataEquityHolding[];
  if (isEquityHoldingsCorrupted(rawEquityHoldings as EquityHolding[])) {
    console.warn(
      '[sync-fund-portfolios] equity_holdings corrupted for category "%s", discarding %d rows',
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

  // Real per-fund cap split from the AMFI classifier. Falls back to the
  // SEBI category-default values only if every holding was un-classifiable
  // (e.g. all foreign equity or an out-of-date AMFI map); in that case we
  // still mark the row 'category_fallback' so the UI can surface a
  // disclaimer rather than presenting fake numbers as measured.
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

  // Stamp each holding's marketCap from the classifier output (or 'Other'
  // when nothing matched). The top_holdings list is the sorted top-50 by
  // weight, so we look up annotations by ISIN+name to preserve sort order.
  const annotatedByKey = new Map<string, MarketCapCategory | 'Other'>();
  for (const a of classification.annotated) {
    annotatedByKey.set(`${(a.isin ?? '').toUpperCase()}|${a.stock_name ?? ''}`, a.marketCap);
  }
  const topHoldings = equityHoldings
    .filter((holding) => holding.stock_name && typeof holding.weight_pct === 'number')
    .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))
    .slice(0, 50)
    .map((holding) => ({
      name: holding.stock_name!,
      isin: holding.isin ?? '',
      sector: holding.sector ?? 'Other',
      marketCap: annotatedByKey.get(`${(holding.isin ?? '').toUpperCase()}|${holding.stock_name ?? ''}`) ?? 'Other',
      pctOfNav: holding.weight_pct!,
    }));

  const classifierHits = classification.annotated.filter((a) => a.marketCap !== 'Other').length;
  const classifierMisses = classification.annotated.length - classifierHits;

  return {
    equityPct: Math.round(equityPct * 100) / 100,
    debtPct: Math.round(debtPct * 100) / 100,
    cashPct: Math.round(cashPct * 100) / 100,
    otherPct: Math.round(otherPct * 100) / 100,
    largeCapPct,
    midCapPct,
    smallCapPct,
    notClassifiedPct,
    classifierOutcome: hasClassifierCoverage ? 'amfi' : 'category_fallback',
    classifierHits,
    classifierMisses,
    sectorAllocation: Object.keys(sectorAllocation).length > 0 ? sectorAllocation : null,
    topHoldings: topHoldings.length > 0 ? topHoldings : null,
    rawDebtHoldings,
  };
}

interface SchemeRow {
  id: string;
  scheme_code: number;
  scheme_category: string;
}

/**
 * Pulls the full ISIN → market-cap map from `stock_market_cap`. ~750 rows
 * is well under one PostgREST page, but we read in chunks for safety.
 * Returns an empty map (and logs) when the table is missing or empty —
 * the cron should not fail outright if the classifier seeder hasn't run
 * yet; downstream code degrades to `category_fallback` per-fund.
 */
async function loadIsinToCapMap(
  client: ReturnType<typeof createServiceClient>,
): Promise<Map<string, MarketCapCategory>> {
  const map = new Map<string, MarketCapCategory>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from('stock_market_cap')
      .select('isin, market_cap_category')
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn('[sync-fund-portfolios] stock_market_cap load failed: %s', error.message);
      return map;
    }
    if (!data || data.length === 0) break;
    for (const row of data as { isin: string; market_cap_category: MarketCapCategory }[]) {
      map.set(row.isin.toUpperCase(), row.market_cap_category);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  console.log('[sync-fund-portfolios] invoked method=%s', req.method);

  const supabase = createServiceClient();
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Load all active funds across all users (global data — not per-user)
  const { data: funds, error: fundsError } = await supabase
    .from('fund')
    .select('id, scheme_code, scheme_category')
    .eq('is_active', true);

  if (fundsError) {
    console.error('[sync-fund-portfolios] failed to load funds:', fundsError.message);
    return json({ success: false, error: fundsError.message }, { status: 500 });
  }

  if (!funds?.length) {
    return json({ success: true, message: 'No active funds', categorySynced: 0, amfiSynced: 0 });
  }

  // Deduplicate by scheme_code (multiple users can hold the same fund)
  const schemeMap = new Map<number, SchemeRow>();
  for (const f of funds as SchemeRow[]) {
    if (!schemeMap.has(f.scheme_code)) schemeMap.set(f.scheme_code, f);
  }
  const schemes = [...schemeMap.values()];
  console.log('[sync-fund-portfolios] %d distinct schemes to process', schemes.length);

  // Load the AMFI ISIN → market cap map once for the whole run. The
  // ~750-row table fits in well under 100 KB and the classifier hits it
  // for every fund we sync — pulling it once is much cheaper than
  // re-querying per scheme.
  const isinToCap = await loadIsinToCapMap(supabase);
  console.log('[sync-fund-portfolios] loaded %d ISIN classifications', isinToCap.size);

  // Bootstrap guard: if `stock_market_cap` is empty (the seeder cron
  // hasn't run yet), don't proceed with the holdings-driven sync.
  // The classifier would return zero coverage on every fund and we'd
  // write `category_fallback` rows for the entire universe — which
  // then persist forever (the unique key is
  // `(scheme_code, portfolio_date, source)`, so the eventual `amfi`
  // rows from the next cron coexist with them rather than replacing).
  // Skip the holdings path; fall through to `category_rules` so the
  // Insights screen still has a baseline. The next cron run retries.
  // See `docs/architecture/cache-surfaces.md` audit finding #7.
  const skipHoldingsForEmptyClassifier = shouldSkipHoldingsSyncForEmptyClassifier(isinToCap.size);
  if (skipHoldingsForEmptyClassifier) {
    console.warn(
      '[sync-fund-portfolios] stock_market_cap is empty; skipping holdings sync, ' +
      'falling through to category_rules. Run sync-stock-market-cap first.',
    );
  }

  // Check which schemes already have fresh holdings-derived data this month.
  // Both 'amfi' (classifier hit) and 'category_fallback' (classifier missed
  // despite having holdings) count as "real-holdings attempt completed" —
  // the input data only changes monthly, so re-fetching mfdata would just
  // burn rate-limit headroom.
  const schemeCodes = schemes.map((s) => s.scheme_code);
  const { data: existing } = await supabase
    .from('fund_portfolio_composition')
    .select('scheme_code, source, portfolio_date')
    .in('scheme_code', schemeCodes)
    .gte('portfolio_date', currentMonthStart.toISOString().split('T')[0])
    .in('source', ['amfi', 'category_fallback']);

  const freshAmfiCodes = new Set((existing ?? []).map((r: { scheme_code: number }) => r.scheme_code));
  const staleSchemes = schemes.filter((s) => !freshAmfiCodes.has(s.scheme_code));
  console.log('[sync-fund-portfolios] %d schemes need richer-data refresh', staleSchemes.length);

  let amfiSynced = 0;
  let classifierHitCount = 0;
  let classifierFallbackCount = 0;
  let equityCorruptionGuardTrips = 0;
  let classifierCoverageSum = 0;
  let classifierCoverageSamples = 0;
  const amfiErrors: string[] = [];

  // When the classifier table is empty, run the loop with an empty work
  // list — the precheck-confirmed `staleSchemes` set is what would have
  // been processed; we skip mfdata calls entirely. `categorySynced` below
  // still seeds category_rules for funds without any holdings-derived row.
  const schemesToProcess = skipHoldingsForEmptyClassifier ? [] : staleSchemes;

  const amfiResults = await Promise.allSettled(
    schemesToProcess.map(async (scheme, idx) => {
      if (idx > 0) await delay(REQUEST_DELAY_MS);

      let synced = 0;
      const portfolioDate = new Date(now.getFullYear(), now.getMonth(), 0) // last day of previous month
        .toISOString().split('T')[0];

      try {
        const schemeInfo = await getSchemeInfo(scheme.scheme_code);
        if (!schemeInfo?.family_id) {
          console.warn('[sync-fund-portfolios] scheme %d: no family_id from mfdata.in', scheme.scheme_code);
          return { schemeCode: scheme.scheme_code, synced: 0, error: 'no_family_id' };
        }

        await delay(REQUEST_DELAY_MS);

        const holdings = await getFamilyHoldings(schemeInfo.family_id);
        if (!holdings || !holdings.equity_holdings?.length) {
          console.warn(
            '[sync-fund-portfolios] scheme %d (family %d): no holdings data',
            scheme.scheme_code,
            schemeInfo.family_id,
          );
          return { schemeCode: scheme.scheme_code, synced: 0, error: 'no_holdings' };
        }

        const portfolio = buildPortfolioFromHoldings(holdings, scheme.scheme_category, isinToCap);
        if (portfolio.classifierOutcome === 'amfi') classifierHitCount += 1;
        else classifierFallbackCount += 1;
        if (portfolio.classifierMisses > 0 && portfolio.classifierHits === 0) {
          // No hits at all in spite of having holdings — separately countable
          // for diagnostics but already covered by classifierFallbackCount.
        }
        if (portfolio.topHoldings && portfolio.topHoldings.length > 0) {
          const cov = portfolio.largeCapPct + portfolio.midCapPct + portfolio.smallCapPct;
          classifierCoverageSum += cov;
          classifierCoverageSamples += 1;
        }
        // The guard only trips when raw input was non-empty AND we discarded it.
        if ((holdings.equity_holdings?.length ?? 0) > 0 && (portfolio.topHoldings?.length ?? 0) === 0) {
          equityCorruptionGuardTrips += 1;
        }

        const sourceTag = portfolio.classifierOutcome === 'amfi' ? 'amfi' : 'category_fallback';

        const { error } = await supabase
          .from('fund_portfolio_composition')
          .upsert({
            scheme_code: scheme.scheme_code,
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
          console.error('[sync-fund-portfolios] scheme %d upsert error: %s', scheme.scheme_code, error.message);
          return { schemeCode: scheme.scheme_code, synced: 0, error: error.message };
        }

        synced++;
        amfiSynced++;
        return { schemeCode: scheme.scheme_code, synced, error: null };
      } catch (err) {
        console.error('[sync-fund-portfolios] scheme %d: %s', scheme.scheme_code, String(err));
        return { schemeCode: scheme.scheme_code, synced: 0, error: String(err) };
      }
    }),
  );

  for (const result of amfiResults) {
    if (result.status === 'rejected') {
      amfiErrors.push(String(result.reason));
    } else if (result.value.error) {
      amfiErrors.push(`${result.value.schemeCode}: ${result.value.error}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Layer 1: seed category_rules for any scheme still missing composition data
  // ---------------------------------------------------------------------------
  const today = now.toISOString().split('T')[0];
  let categorySynced = 0;

  // Re-check which schemes now have holdings-derived data (real or fallback).
  // category_rules is the *last* resort — funds with category_fallback have
  // already been seen by the holdings path this cycle.
  const { data: nowHasAmfi } = await supabase
    .from('fund_portfolio_composition')
    .select('scheme_code')
    .in('scheme_code', schemeCodes)
    .gte('portfolio_date', currentMonthStart.toISOString().split('T')[0])
    .in('source', ['amfi', 'category_fallback']);

  const amfiCodeSet = new Set((nowHasAmfi ?? []).map((r: { scheme_code: number }) => r.scheme_code));
  const needsCategoryRules = schemes.filter((s) => !amfiCodeSet.has(s.scheme_code));

  if (needsCategoryRules.length > 0) {
    const categoryRows = needsCategoryRules.map((scheme) => {
      const comp = getCategoryRules(scheme.scheme_category);
      const notClassified = Math.max(0, 100 - comp.large - comp.mid - comp.small);
      return {
        scheme_code: scheme.scheme_code,
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
      };
    });

    const { error: catError } = await supabase
      .from('fund_portfolio_composition')
      .upsert(categoryRows, {
        onConflict: 'scheme_code,portfolio_date,source',
        ignoreDuplicates: true, // never overwrite existing category_rules with stale approximation
      });

    if (catError) {
      console.error('[sync-fund-portfolios] category_rules upsert error:', catError.message);
    } else {
      categorySynced = categoryRows.length;
      console.log('[sync-fund-portfolios] seeded category_rules for %d schemes', categorySynced);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log('[sync-fund-portfolios] done — amfiSynced=%d categorySynced=%d errors=%d, elapsed_ms=%d',
    amfiSynced, categorySynced, amfiErrors.length, elapsedMs);

  const classifierCoveragePctAvg = classifierCoverageSamples > 0
    ? Math.round((classifierCoverageSum / classifierCoverageSamples) * 100) / 100
    : 0;

  // The bootstrap-empty-classifier path is a known dependency-ordering
  // issue, not a true failure — surface it as `sync_completed` with a
  // distinct property so an alert can fire if it persists past the
  // first hour after `sync-stock-market-cap` is supposed to land.
  await trackServerEventAwait(
    amfiErrors.length > 0 && amfiSynced === 0 ? 'sync_failed' : 'sync_completed',
    {
      job: 'sync-fund-portfolios',
      schemes_processed: schemes.length,
      amfi_synced: amfiSynced,
      category_synced: categorySynced,
      fresh_skipped: freshAmfiCodes.size,
      errors_count: amfiErrors.length,
      classifier_hit_count: classifierHitCount,
      classifier_fallback_count: classifierFallbackCount,
      classifier_no_holdings_count: categorySynced,
      classifier_coverage_pct_avg: classifierCoveragePctAvg,
      equity_corruption_guard_trips: equityCorruptionGuardTrips,
      classifier_table_size: isinToCap.size,
      classifier_table_empty_skip: skipHoldingsForEmptyClassifier,
      elapsed_ms: elapsedMs,
    },
    'system:sync-fund-portfolios',
  );

  return json({
    success: true,
    schemesProcessed: schemes.length,
    amfiSynced,
    categorySynced,
    freshSkipped: freshAmfiCodes.size,
    errors: amfiErrors,
  });
});
