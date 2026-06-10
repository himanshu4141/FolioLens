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
  isDebtDataCorrupted,
  deriveDebtPct,
  isEquityHoldingsCorrupted,
  isEquityPctPlausible,
  isNumericString,
  deriveSchemeCategoryFromName,
  isGenericSchemeCategory,
} from '../_shared/portfolio-utils.ts';
import { probeUpstream, type UpstreamProbeResult } from '../_shared/upstream-probe.ts';

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

function getCategoryRules(
  schemeCategory: string | null | undefined,
  schemeName?: string | null,
): CategoryComposition {
  // When AMFI/mfdata return the bare single-word "Equity" (or "Hybrid" /
  // "Debt" / "Other"), the legacy lookup landed on a flexi-cap proxy
  // (38/33/29) for every equity scheme — that's the root of the bug where
  // DSP Large/Mid/Small/Large&Mid all displayed the same cap mix on the
  // Compare tab. Resolving the sub-bucket from scheme_name first rescues
  // these funds before they fall through to the proxy.
  if (isGenericSchemeCategory(schemeCategory)) {
    const derivedKey = deriveSchemeCategoryFromName(schemeName);
    if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
  }

  const key = (schemeCategory ?? '').toLowerCase().trim();
  if (CATEGORY_RULES[key]) return CATEGORY_RULES[key];
  if (GENERIC_CATEGORY_MAP[key]) {
    // Last-resort generic bucket. Try scheme_name one more time — even a
    // non-generic-looking scheme_category might be e.g. "Equity Scheme"
    // and benefit from the same rescue.
    const derivedKey = deriveSchemeCategoryFromName(schemeName);
    if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
    return GENERIC_CATEGORY_MAP[key];
  }
  // Partial match: only fire when the key has 2+ words to avoid 'equity' matching 'equity savings fund'
  if (key.split(' ').length >= 2) {
    for (const [pattern, comp] of Object.entries(CATEGORY_RULES)) {
      if (key.includes(pattern) || pattern.includes(key.split(' ').slice(0, 3).join(' '))) {
        return comp;
      }
    }
  }
  // Final attempt — scheme_name resolution even when category is completely
  // unrecognised.
  const derivedKey = deriveSchemeCategoryFromName(schemeName);
  if (derivedKey && CATEGORY_RULES[derivedKey]) return CATEGORY_RULES[derivedKey];
  return FALLBACK_COMPOSITION;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A5: single retry with 2 s delay for transient 5xx / 429 errors.
// Cloudflare 522 / 524 are NOT retried — they mean the origin is offline,
// not flaky; the preflight probe in the handler classifies that case and
// short-circuits the entire fan-out before we get here.
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
    const msg = err instanceof Error ? err.message : '';
    const isCloudflareOriginDown = msg === 'HTTP 522' || msg === 'HTTP 524';
    const isRetryable = !isCloudflareOriginDown &&
      (msg.startsWith('HTTP 5') || msg === 'HTTP 429');
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
  schemeName: string | null,
): EnrichedPortfolio {
  const catRules = getCategoryRules(schemeCategory, schemeName);

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

  // Cap split uses SEBI category defaults — the stock_market_cap ISIN→cap
  // classifier was retired in Phase 2 (OpenFolio-Data now supplies cap_mix
  // via source='official' rows). The mfdata backup path keeps real asset
  // mix / sectors / debt / top_holdings; cap falls through to category rules.
  const largeCapPct = catRules.large;
  const midCapPct = catRules.mid;
  const smallCapPct = catRules.small;
  const notClassifiedPct = Math.max(0, 100 - catRules.large - catRules.mid - catRules.small);

  const topHoldings = equityHoldings
    .filter((holding) => holding.stock_name && typeof holding.weight_pct === 'number')
    .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))
    .slice(0, 50)
    .map((holding) => ({
      name: holding.stock_name!,
      isin: holding.isin ?? '',
      sector: holding.sector ?? 'Other',
      marketCap: 'Other',
      pctOfNav: holding.weight_pct!,
    }));

  return {
    equityPct: Math.round(equityPct * 100) / 100,
    debtPct: Math.round(debtPct * 100) / 100,
    cashPct: Math.round(cashPct * 100) / 100,
    otherPct: Math.round(otherPct * 100) / 100,
    largeCapPct,
    midCapPct,
    smallCapPct,
    notClassifiedPct,
    sectorAllocation: Object.keys(sectorAllocation).length > 0 ? sectorAllocation : null,
    topHoldings: topHoldings.length > 0 ? topHoldings : null,
    rawDebtHoldings,
  };
}

interface SchemeRow {
  id: string;
  scheme_code: number;
  scheme_category: string;
  scheme_name: string | null;
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

  // Load all active funds across all users (global data — not per-user).
  // scheme_name is pulled so that schemes filed under the bare
  // single-word category "Equity" / "Hybrid" / "Debt" can still be
  // mapped to their actual SEBI sub-bucket via name-based heuristics.
  const { data: funds, error: fundsError } = await supabase
    .from('fund')
    .select('id, scheme_code, scheme_category, scheme_name')
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
    // 'official' (OpenFolio) outranks 'amfi' — when it's present and fresh,
    // the read path uses it regardless, so there's no need to re-fetch
    // mfdata for that scheme this cycle. mfdata stays a backup source.
    .in('source', ['official', 'amfi', 'category_fallback']);

  const freshAmfiCodes = new Set((existing ?? []).map((r: { scheme_code: number }) => r.scheme_code));
  const staleSchemes = schemes.filter((s) => !freshAmfiCodes.has(s.scheme_code));
  console.log('[sync-fund-portfolios] %d schemes need richer-data refresh', staleSchemes.length);

  // Preflight probe: if mfdata.in is hard-down (5xx / timeout / network),
  // skip the per-scheme fan-out entirely. Without this, an upstream outage
  // generates one hourly `sync_failed` event per cron tick because every
  // per-scheme attempt errors and we emit "all errors, zero synced" → looks
  // identical to a real bug. The category_rules fallback still runs below,
  // so Insights stays populated.
  let upstreamSkipped: UpstreamProbeResult | null = null;
  if (staleSchemes.length > 0) {
    const probe = await probeUpstream(`${MFDATA_BASE}/schemes/${staleSchemes[0].scheme_code}`);
    if (probe.status === 'down') {
      console.warn(
        '[sync-fund-portfolios] mfdata.in upstream down — reason=%s http_status=%s, skipping AMFI fan-out',
        probe.reason,
        probe.httpStatus ?? 'n/a',
      );
      upstreamSkipped = probe;
    } else {
      console.log('[sync-fund-portfolios] mfdata.in preflight ok, proceeding with AMFI fan-out');
    }
  }

  let amfiSynced = 0;
  let equityCorruptionGuardTrips = 0;
  const amfiErrors: string[] = [];

  const schemesToProcess = upstreamSkipped ? [] : staleSchemes;

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

        const portfolio = buildPortfolioFromHoldings(
          holdings,
          scheme.scheme_category,
          scheme.scheme_name,
        );
        // The guard only trips when raw input was non-empty AND we discarded it.
        if ((holdings.equity_holdings?.length ?? 0) > 0 && (portfolio.topHoldings?.length ?? 0) === 0) {
          equityCorruptionGuardTrips += 1;
        }

        // mfdata path now always tags as category_fallback (real holdings data
        // but cap from SEBI defaults — same disclaimer as before for this tail).
        const sourceTag = 'category_fallback';

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

  // Sentinel date: category_rules rows use '1900-01-01' as portfolio_date so
  // that every run upserts the same (scheme_code, '1900-01-01', 'category_rules')
  // key, guaranteeing exactly one row per scheme. Using the run date (today)
  // caused one new row per day because the UNIQUE key
  // (scheme_code, portfolio_date, source) distinguished every calendar date.
  // The sentinel is safe because pickBestCompositionRows ranks category_rules
  // last (rank 0), so this date can never displace a higher-ranked row in the
  // read path regardless of how old it looks.
  const CATEGORY_RULES_SENTINEL_DATE = '1900-01-01';
  let categorySynced = 0;

  // Re-check which schemes now have holdings-derived data (real or fallback).
  // category_rules is the *last* resort — funds with category_fallback have
  // already been seen by the holdings path this cycle.
  const { data: nowHasAmfi } = await supabase
    .from('fund_portfolio_composition')
    .select('scheme_code')
    .in('scheme_code', schemeCodes)
    .gte('portfolio_date', currentMonthStart.toISOString().split('T')[0])
    .in('source', ['official', 'amfi', 'category_fallback']);

  const amfiCodeSet = new Set((nowHasAmfi ?? []).map((r: { scheme_code: number }) => r.scheme_code));
  const needsCategoryRules = schemes.filter((s) => !amfiCodeSet.has(s.scheme_code));

  if (needsCategoryRules.length > 0) {
    const categoryRows = needsCategoryRules.map((scheme) => {
      const comp = getCategoryRules(scheme.scheme_category, scheme.scheme_name);
      const notClassified = Math.max(0, 100 - comp.large - comp.mid - comp.small);
      return {
        scheme_code: scheme.scheme_code,
        portfolio_date: CATEGORY_RULES_SENTINEL_DATE,
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
        // Update (not ignore) on conflict. category_rules is a deterministic
        // function of (scheme_category, scheme_name) — a re-run is always
        // equal-or-better, never staler. ignoreDuplicates:true used to skip
        // the write, trapping funds on the stale 38/33/29 flexi-cap proxy
        // even after PR #188 taught getCategoryRules to derive the real
        // sub-bucket from scheme_name (e.g. DSP Mid Cap → 8/75/17).
        ignoreDuplicates: false,
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

  let eventName: 'sync_skipped_upstream_down' | 'sync_failed' | 'sync_completed';
  if (upstreamSkipped) {
    eventName = 'sync_skipped_upstream_down';
  } else if (amfiErrors.length > 0 && amfiSynced === 0) {
    eventName = 'sync_failed';
  } else {
    eventName = 'sync_completed';
  }

  await trackServerEventAwait(
    eventName,
    {
      job: 'sync-fund-portfolios',
      schemes_processed: schemes.length,
      amfi_synced: amfiSynced,
      category_synced: categorySynced,
      fresh_skipped: freshAmfiCodes.size,
      errors_count: amfiErrors.length,
      equity_corruption_guard_trips: equityCorruptionGuardTrips,
      elapsed_ms: elapsedMs,
      upstream_status: upstreamSkipped ? 'down' : 'up',
      upstream_reason: upstreamSkipped?.reason ?? null,
      upstream_http_status: upstreamSkipped?.httpStatus ?? null,
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
    upstreamSkipped: upstreamSkipped
      ? { reason: upstreamSkipped.reason, httpStatus: upstreamSkipped.httpStatus ?? null }
      : null,
  });
});
