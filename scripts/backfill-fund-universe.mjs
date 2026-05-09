/**
 * backfill-fund-universe.mjs — universe-wide hydration of scheme_master,
 * fund_portfolio_composition, and nav_history. Runs from GitHub Actions on a
 * daily cron (and on-demand via workflow_dispatch).
 *
 * Why
 * ===
 * Compare Funds and Past SIP Check let users pick ANY fund in the AMFI
 * universe (~37,595 codes after the seed). On-demand fetches at pick time
 * give a 1-2s spinner and a poor first impression. The proactive backfill
 * keeps the universe pre-hydrated so reads in the screens are sub-50ms
 * cache hits.
 *
 * Strategy
 * ========
 * - Process the oldest `last_backfill_attempted_at` first (NULL first), so
 *   never-synced schemes get covered before refreshes.
 * - Hard cap per run: BATCH_SIZE schemes. Default 600 (~30-50 minutes wall-
 *   time at observed mfdata.in latency). Tune via env.
 * - Skip schemes flagged `is_inactive=true`. Once a week a separate slow-
 *   lane re-checks them; not implemented in v1, just leave the flag.
 * - Per scheme, three stages, each fault-isolated:
 *     1. Metadata via mfdata.in /schemes/{code}
 *     2. Composition via mfdata.in /families/{family_id}/holdings
 *     3. NAV history via mfapi.in /mf/{code}
 *   Failure in one stage doesn't block the others.
 * - On 5 consecutive failures (no data from any source), set is_inactive=true.
 *
 * Rate limits
 * -----------
 * mfdata.in: 120 req/min, 10k req/day. Each scheme uses up to 2 mfdata calls
 *   → 600 schemes × 2 = 1200 calls per run, well under daily limit.
 * mfapi.in: no documented limit but be polite — 200ms delay between calls.
 *
 * Storage impact
 * --------------
 * NAV history: each scheme ~500-3000 rows; full universe ≈ 30-50M rows.
 * That's the biggest write cost. We chunk upserts at 500 rows.
 *
 * Required env
 * ============
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (RLS bypass)
 *
 * Optional env
 * ============
 *   BACKFILL_BATCH_SIZE       — schemes per run (default 600)
 *   BACKFILL_SKIP_NAV         — '1' to skip stage 3 (faster, metadata-only)
 *   BACKFILL_OFFSET           — skip first N rows (for parallel matrix runs)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[backfill-fund-universe] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE ?? '600');
const BACKFILL_OFFSET = Number(process.env.BACKFILL_OFFSET ?? '0');
const SKIP_NAV = process.env.BACKFILL_SKIP_NAV === '1';
const META_DELAY_MS = 250;        // 240/min headroom under mfdata's 120/min
const NAV_DELAY_MS = 200;
const NAV_UPSERT_CHUNK = 500;
const FETCH_TIMEOUT_MS = 12_000;
const FAILURE_INACTIVE_THRESHOLD = 5;

const MFDATA_BASE = 'https://mfdata.in/api/v1';
const MFAPI_BASE = 'https://api.mfapi.in/mf';
const MFDATA_USER_AGENT = 'Mozilla/5.0 (compatible; FolioLens/1.0; +https://foliolens.in)';

// SEBI category → fallback composition (compact copy of sync-fund-portfolios).
const CATEGORY_RULES = {
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
  'aggressive hybrid fund':    { equity: 78, debt: 17, cash: 5,  other: 0, large: 48, mid: 28, small: 24 },
  'balanced hybrid fund':      { equity: 50, debt: 45, cash: 5,  other: 0, large: 55, mid: 28, small: 17 },
  'conservative hybrid fund':  { equity: 20, debt: 73, cash: 7,  other: 0, large: 60, mid: 25, small: 15 },
  'balanced advantage fund':   { equity: 55, debt: 35, cash: 10, other: 0, large: 55, mid: 28, small: 17 },
  'multi asset allocation':    { equity: 50, debt: 30, cash: 10, other: 10, large: 50, mid: 28, small: 22 },
  'arbitrage fund':            { equity: 65, debt: 30, cash: 5,  other: 0, large: 75, mid: 20, small: 5  },
  'liquid fund':               { equity: 0,  debt: 20, cash: 80, other: 0, large: 0,  mid: 0,  small: 0  },
  'overnight fund':            { equity: 0,  debt: 5,  cash: 95, other: 0, large: 0,  mid: 0,  small: 0  },
  'index funds':               { equity: 95, debt: 0,  cash: 5,  other: 0, large: 90, mid: 8,  small: 2  },
  'fund of funds investing overseas': { equity: 0, debt: 0, cash: 0, other: 100, large: 0, mid: 0, small: 0 },
};
const FALLBACK_COMP = { equity: 80, debt: 10, cash: 10, other: 0, large: 50, mid: 30, small: 20 };
function categoryRules(cat) {
  if (!cat) return FALLBACK_COMP;
  const key = cat.toLowerCase().trim();
  if (CATEGORY_RULES[key]) return CATEGORY_RULES[key];
  if (key.startsWith('debt')) return { equity: 0, debt: 92, cash: 8, other: 0, large: 0, mid: 0, small: 0 };
  if (key.startsWith('hybrid')) return CATEGORY_RULES['aggressive hybrid fund'];
  return FALLBACK_COMP;
}

const isNumericString = (s) => typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s);
function isDebtCorrupted(rows) {
  return rows.some((h) => isNumericString(h?.holding_type) || isNumericString(h?.credit_rating));
}
function isEquityImplausible(rawEquity, rules) {
  if (typeof rawEquity !== 'number') return true;
  if (rules.equity >= 80 && rawEquity < 50) return true;
  if (rules.debt >= 80 && rawEquity > 20) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function mfdataGet(path) {
  return withTimeout(async (signal) => {
    const res = await fetch(`${MFDATA_BASE}${path}`, {
      signal,
      headers: { 'User-Agent': MFDATA_USER_AGENT, Accept: 'application/json' },
    });
    if (res.status === 429) return { status: 'rate_limited' };
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'http_error', code: res.status };
    const body = await res.json();
    return { status: 'ok', data: body?.data ?? body ?? null };
  }, FETCH_TIMEOUT_MS).catch((err) => ({ status: 'http_error', err: String(err) }));
}

async function mfapiGet(schemeCode) {
  return withTimeout(async (signal) => {
    const res = await fetch(`${MFAPI_BASE}/${schemeCode}`, { signal });
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'http_error', code: res.status };
    const body = await res.json();
    return { status: 'ok', data: body };
  }, FETCH_TIMEOUT_MS).catch((err) => ({ status: 'http_error', err: String(err) }));
}

function ddmmyyyyToIso(d) {
  const m = typeof d === 'string' && d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function toCrores(amount) {
  if (amount == null || Number.isNaN(amount)) return null;
  return Math.round((amount / 10_000_000) * 100) / 100;
}

// --- Stage 1: scheme_master metadata --------------------------------------

async function syncMeta(schemeCode, current) {
  const result = await mfdataGet(`/schemes/${schemeCode}`);
  if (result.status !== 'ok' || !result.data) {
    return { status: result.status, family_id: null, scheme_category: current?.scheme_category ?? null };
  }
  const m = result.data;
  const isin = typeof m.isin === 'string' && m.isin.length > 0 ? m.isin : null;
  const er = m.expense_ratio != null ? Number(m.expense_ratio) : null;
  const aum = toCrores(m.aum);
  const minSip = m.min_sip != null ? Math.round(Number(m.min_sip)) : null;
  const minLump = m.min_lumpsum != null ? Math.round(Number(m.min_lumpsum)) : null;
  const minAdd = m.min_additional != null ? Math.round(Number(m.min_additional)) : null;
  const morn = m.morningstar != null ? Math.round(Number(m.morningstar)) : null;
  const launch = typeof m.launch_date === 'string' && m.launch_date.length > 0 ? m.launch_date : null;
  const now = new Date().toISOString();

  const payload = {
    fund_meta_synced_at: now,
    mfdata_meta_synced_at: now,
  };
  if (isin) payload.isin = isin;
  if (er != null) payload.expense_ratio = er;
  if (aum != null) payload.aum_cr = aum;
  if (minSip != null) payload.min_sip_amount = minSip;
  if (minLump != null) payload.min_lumpsum = minLump;
  if (minAdd != null) payload.min_additional = minAdd;
  if (launch) payload.launch_date = launch;
  if (m.benchmark) payload.declared_benchmark_name = m.benchmark;
  if (m.risk_label) payload.risk_label = m.risk_label;
  if (morn != null) payload.morningstar_rating = morn;
  if (m.related_variants) payload.related_variants = m.related_variants;
  if (m.exit_load !== undefined) payload.exit_load = m.exit_load ?? null;
  if (m.plan_type) payload.plan_type = m.plan_type;
  if (m.option_type) payload.option_type = m.option_type;
  if (m.family_name) payload.family_name = m.family_name;
  if (m.amc_name) payload.amc_name = m.amc_name;
  if (m.amc_slug) payload.amc_slug = m.amc_slug;
  if (m.family_id != null) payload.mfdata_family_id = m.family_id;
  if (m.returns) payload.period_returns = m.returns;
  if (m.ratios) payload.risk_ratios = m.ratios;
  if (m.category && !current?.scheme_category) payload.scheme_category = m.category;

  const { error } = await supabase.from('scheme_master').update(payload).eq('scheme_code', schemeCode);
  if (error) return { status: 'http_error', family_id: null, scheme_category: current?.scheme_category ?? null, err: error.message };

  return {
    status: 'ok',
    family_id: m.family_id ?? null,
    scheme_category: m.category ?? current?.scheme_category ?? null,
  };
}

// --- Stage 2: composition --------------------------------------------------

async function syncComposition(schemeCode, familyId, schemeCategory) {
  if (familyId == null) {
    await seedCategoryRules(schemeCode, schemeCategory);
    return 'category_rules';
  }
  const result = await mfdataGet(`/families/${familyId}/holdings`);
  if (result.status !== 'ok' || !result.data || !result.data.equity_holdings?.length) {
    await seedCategoryRules(schemeCode, schemeCategory);
    return 'category_rules';
  }
  const built = buildPortfolio(result.data, schemeCategory ?? '');
  const portfolioDate = (() => {
    const d = new Date();
    d.setDate(0); // last day of previous month
    return d.toISOString().split('T')[0];
  })();
  const notClassified = Math.max(0, 100 - built.largeCapPct - built.midCapPct - built.smallCapPct);

  const { error } = await supabase.from('fund_portfolio_composition').upsert({
    scheme_code: schemeCode,
    portfolio_date: portfolioDate,
    equity_pct: built.equityPct,
    debt_pct: built.debtPct,
    cash_pct: built.cashPct,
    other_pct: built.otherPct,
    large_cap_pct: built.largeCapPct,
    mid_cap_pct: built.midCapPct,
    small_cap_pct: built.smallCapPct,
    not_classified_pct: notClassified,
    sector_allocation: built.sectorAllocation,
    top_holdings: built.topHoldings,
    raw_debt_holdings: built.rawDebtHoldings,
    source: 'amfi',
    synced_at: new Date().toISOString(),
  }, { onConflict: 'scheme_code,portfolio_date,source' });

  if (error) {
    console.warn('[backfill] scheme=%d composition upsert error: %s', schemeCode, error.message);
    return 'http_error';
  }
  return 'amfi';
}

async function seedCategoryRules(schemeCode, schemeCategory) {
  const today = new Date().toISOString().split('T')[0];
  const c = categoryRules(schemeCategory);
  const notClassified = Math.max(0, 100 - c.large - c.mid - c.small);
  await supabase.from('fund_portfolio_composition').upsert({
    scheme_code: schemeCode,
    portfolio_date: today,
    equity_pct: c.equity,
    debt_pct: c.debt,
    cash_pct: c.cash,
    other_pct: c.other,
    large_cap_pct: c.large,
    mid_cap_pct: c.mid,
    small_cap_pct: c.small,
    not_classified_pct: notClassified,
    sector_allocation: null,
    top_holdings: null,
    raw_debt_holdings: null,
    source: 'category_rules',
    synced_at: new Date().toISOString(),
  }, { onConflict: 'scheme_code,portfolio_date,source', ignoreDuplicates: true });
}

function buildPortfolio(holdings, schemeCategory) {
  const rules = categoryRules(schemeCategory);
  const rawEq = holdings.equity_pct;
  const eqValid = !isEquityImplausible(rawEq, rules);
  const equityPct = eqValid && typeof rawEq === 'number' ? rawEq : rules.equity;
  const debt = holdings.debt_holdings ?? [];
  let debtPct;
  let raw = null;
  if (debt.length > 0) {
    if (isDebtCorrupted(debt)) {
      debtPct = Math.min(rules.debt, Math.max(0, 100 - equityPct));
    } else {
      const sum = debt.reduce((s, h) => s + (h.weight_pct ?? 0), 0);
      debtPct = sum > 0 ? Math.round(sum * 100) / 100 : Math.min(rules.debt, Math.max(0, 100 - equityPct));
      raw = debt;
    }
  } else {
    debtPct = Math.min(rules.debt, Math.max(0, 100 - equityPct));
  }
  const cashPct = Math.max(0, 100 - equityPct - debtPct);
  const sectorMap = {};
  const eqH = holdings.equity_holdings ?? [];
  for (const h of eqH) {
    if (h.sector && typeof h.weight_pct === 'number') {
      sectorMap[h.sector] = (sectorMap[h.sector] ?? 0) + h.weight_pct;
    }
  }
  const sectorAllocation = {};
  for (const [s, w] of Object.entries(sectorMap).sort(([, a], [, b]) => b - a)) {
    sectorAllocation[s] = Math.round(w * 100) / 100;
  }
  const topHoldings = eqH
    .filter((h) => h.stock_name && typeof h.weight_pct === 'number')
    .sort((a, b) => (b.weight_pct ?? 0) - (a.weight_pct ?? 0))
    .slice(0, 50)
    .map((h) => ({
      name: h.stock_name,
      isin: h.isin ?? '',
      sector: h.sector ?? 'Other',
      marketCap: 'Other',
      pctOfNav: h.weight_pct,
    }));
  return {
    equityPct: Math.round(equityPct * 100) / 100,
    debtPct: Math.round(debtPct * 100) / 100,
    cashPct: Math.round(cashPct * 100) / 100,
    otherPct: 0,
    largeCapPct: rules.large,
    midCapPct: rules.mid,
    smallCapPct: rules.small,
    sectorAllocation: Object.keys(sectorAllocation).length > 0 ? sectorAllocation : null,
    topHoldings: topHoldings.length > 0 ? topHoldings : null,
    rawDebtHoldings: raw,
  };
}

// --- Stage 3: nav_history --------------------------------------------------

async function syncNav(schemeCode) {
  // Cache check — skip if latest NAV is from yesterday or today.
  const { data: latest } = await supabase
    .from('nav_history')
    .select('nav_date')
    .eq('scheme_code', schemeCode)
    .order('nav_date', { ascending: false })
    .limit(1);
  const latestDate = latest?.[0]?.nav_date ?? null;
  if (latestDate) {
    const ageDays = (Date.now() - new Date(latestDate).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays <= 2) return { status: 'cache_hit', rows: 0 };
  }

  const result = await mfapiGet(schemeCode);
  if (result.status !== 'ok' || !Array.isArray(result.data?.data)) {
    return { status: result.status, rows: 0 };
  }
  const rows = result.data.data
    .map((r) => {
      const iso = ddmmyyyyToIso(r.date);
      const nav = Number(r.nav);
      if (!iso || !Number.isFinite(nav) || nav <= 0) return null;
      return { scheme_code: schemeCode, nav_date: iso, nav };
    })
    .filter(Boolean);
  if (rows.length === 0) return { status: 'no_data', rows: 0 };

  let upserted = 0;
  for (let i = 0; i < rows.length; i += NAV_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + NAV_UPSERT_CHUNK);
    const { error } = await supabase
      .from('nav_history')
      .upsert(chunk, { onConflict: 'scheme_code,nav_date' });
    if (error) {
      console.warn('[backfill] scheme=%d NAV chunk error: %s', schemeCode, error.message);
      return { status: 'http_error', rows: upserted };
    }
    upserted += chunk.length;
  }
  return { status: 'ok', rows: upserted };
}

// --- Per-scheme orchestrator ----------------------------------------------

async function processScheme(row) {
  const schemeCode = row.scheme_code;
  const startedAt = Date.now();

  await sleep(META_DELAY_MS);
  const meta = await syncMeta(schemeCode, row);

  let composition = null;
  if (meta.status === 'ok') {
    await sleep(META_DELAY_MS);
    composition = await syncComposition(schemeCode, meta.family_id, meta.scheme_category);
  }

  let nav = null;
  if (!SKIP_NAV) {
    await sleep(NAV_DELAY_MS);
    nav = await syncNav(schemeCode);
  }

  // Decide overall outcome.
  // - meta=ok + composition=amfi → 'success'
  // - meta=ok + composition=category_rules → 'partial' (got metadata but no rich holdings)
  // - meta=not_found and nav=not_found → 'no_data' (deserves inactive flag escalation)
  // - meta=rate_limited → 'rate_limited'
  // - any other → 'http_error'
  let outcome;
  if (meta.status === 'rate_limited') outcome = 'rate_limited';
  else if (meta.status === 'ok' && composition === 'amfi') outcome = 'success';
  else if (meta.status === 'ok') outcome = 'partial';
  else if (meta.status === 'not_found' && (nav?.status === 'not_found' || nav?.status === 'no_data')) outcome = 'no_data';
  else outcome = 'http_error';

  const isSuccess = outcome === 'success' || outcome === 'partial';
  const newFailureCount = isSuccess ? 0 : (row.backfill_failure_count ?? 0) + 1;
  const isInactive = newFailureCount >= FAILURE_INACTIVE_THRESHOLD;

  const update = {
    last_backfill_attempted_at: new Date().toISOString(),
    backfill_outcome: outcome,
    backfill_failure_count: newFailureCount,
  };
  if (isInactive) update.is_inactive = true;
  await supabase.from('scheme_master').update(update).eq('scheme_code', schemeCode);

  const elapsedMs = Date.now() - startedAt;
  return {
    schemeCode,
    outcome,
    metaStatus: meta.status,
    compositionStatus: composition,
    navStatus: nav?.status ?? 'skipped',
    navRows: nav?.rows ?? 0,
    failureCount: newFailureCount,
    markedInactive: isInactive,
    elapsedMs,
  };
}

// --- Main ------------------------------------------------------------------

async function main() {
  const start = Date.now();
  console.log('[backfill-fund-universe] start: batch=%d offset=%d skipNav=%s',
    BATCH_SIZE, BACKFILL_OFFSET, SKIP_NAV);

  // Pick the next batch — never-synced first, then oldest-attempted first.
  // Two queries to play nice with Supabase's NULLS-FIRST ordering.
  const { data: batch, error } = await supabase
    .from('scheme_master')
    .select('scheme_code, scheme_category, backfill_failure_count, last_backfill_attempted_at')
    .eq('is_inactive', false)
    .order('last_backfill_attempted_at', { ascending: true, nullsFirst: true })
    .range(BACKFILL_OFFSET, BACKFILL_OFFSET + BATCH_SIZE - 1);

  if (error) {
    console.error('[backfill-fund-universe] batch query failed:', error.message);
    process.exit(1);
  }

  console.log('[backfill-fund-universe] processing %d schemes', batch.length);

  const counts = { success: 0, partial: 0, no_data: 0, http_error: 0, rate_limited: 0 };
  let totalNavRows = 0;
  let inactivated = 0;

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i];
    try {
      const r = await processScheme(row);
      counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      totalNavRows += r.navRows;
      if (r.markedInactive) inactivated++;
      if ((i + 1) % 50 === 0) {
        const elapsedSec = ((Date.now() - start) / 1000).toFixed(0);
        console.log(
          '[backfill] %d/%d processed (%s) — counts=%o navRows=%d inactivated=%d elapsed=%ss',
          i + 1, batch.length, r.schemeCode, counts, totalNavRows, inactivated, elapsedSec,
        );
      }
    } catch (err) {
      console.error('[backfill] scheme=%d unexpected error: %s', row.scheme_code, String(err));
      counts.http_error++;
    }
  }

  const totalSec = ((Date.now() - start) / 1000).toFixed(0);
  console.log(
    '[backfill-fund-universe] done — processed=%d outcomes=%o nav_rows_upserted=%d inactivated=%d elapsed=%ss',
    batch.length, counts, totalNavRows, inactivated, totalSec,
  );
}

main().catch((err) => {
  console.error('[backfill-fund-universe] fatal:', err);
  process.exit(1);
});
