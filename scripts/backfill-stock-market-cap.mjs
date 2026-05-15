/**
 * backfill-stock-market-cap.mjs — re-runs the AMFI classifier against every
 * `fund_portfolio_composition` row with `source='amfi'` (or
 * `source='category_fallback'` if you want to retry historical rows after
 * an AMFI list refresh).
 *
 * Why
 * ===
 * Before Phase 9 M6, `large_cap_pct`, `mid_cap_pct`, and `small_cap_pct` were
 * stamped with SEBI category defaults (e.g. every Flexi Cap fund got
 * 38/33/29). The fix in M2 wires the real per-fund classifier into both
 * portfolio-builder edge functions, but that only takes effect for newly-
 * fetched data — the existing ~12k rows in production still carry the fake
 * splits until each fund's next monthly cron tick.
 *
 * This script speeds that up: it iterates rows in batches, runs the
 * `classifyHoldings` logic against the stored `top_holdings` JSONB, and
 * updates the four cap-pct columns + stamps each holding's `marketCap`
 * field. Idempotent (re-running is a no-op on already-fixed rows) and
 * resumable (each batch commits independently).
 *
 * Required env
 * ============
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (RLS bypass)
 *
 * Optional env
 * ============
 *   DRY_RUN          — '1' to log intended updates without writing
 *   BATCH_SIZE       — composition rows per page (default 500)
 *   START_OFFSET     — skip first N rows (for parallel matrix runs)
 *   INCLUDE_FALLBACK — '1' to also re-process source='category_fallback' rows
 *                      (use after a new AMFI list lands to retry the misses)
 *
 * Usage
 * =====
 *   node scripts/backfill-stock-market-cap.mjs --dry-run
 *   node scripts/backfill-stock-market-cap.mjs
 *
 * Sized for a one-shot prod run; takes ~2 minutes for 12k rows on a
 * standard machine. See docs/plans/phase-9-pre-launch-readiness/
 * M6-honest-portfolio-composition.md (Milestone M3).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[backfill] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? '500');
const START_OFFSET = Number(process.env.START_OFFSET ?? '0');
const INCLUDE_FALLBACK = process.env.INCLUDE_FALLBACK === '1';

const SOURCE_FILTER = INCLUDE_FALLBACK ? ['amfi', 'category_fallback'] : ['amfi'];

// ---------------------------------------------------------------------------
// Classifier — duplicated from supabase/functions/_shared/portfolio-utils.ts.
// Kept inline so this script is runnable as plain Node without bundling
// TS. The unit-tested upstream logic and this copy are intentionally
// identical; if you change one, change the other.
// ---------------------------------------------------------------------------

function classifyHoldings(holdings, isinToCap) {
  let largeCapPct = 0;
  let midCapPct = 0;
  let smallCapPct = 0;
  let notClassifiedPct = 0;
  const annotated = [];

  for (const h of holdings ?? []) {
    const weight = typeof h?.pctOfNav === 'number' ? h.pctOfNav
      : typeof h?.weight_pct === 'number' ? h.weight_pct
      : 0;
    if (weight <= 0) {
      annotated.push({ ...h, marketCap: h?.marketCap ?? 'Other' });
      continue;
    }
    const isinKey = String(h?.isin ?? '').trim().toUpperCase();
    const category = isinKey ? isinToCap.get(isinKey) : undefined;
    if (category === 'Large Cap') {
      largeCapPct += weight;
      annotated.push({ ...h, marketCap: 'Large Cap' });
    } else if (category === 'Mid Cap') {
      midCapPct += weight;
      annotated.push({ ...h, marketCap: 'Mid Cap' });
    } else if (category === 'Small Cap') {
      smallCapPct += weight;
      annotated.push({ ...h, marketCap: 'Small Cap' });
    } else {
      notClassifiedPct += weight;
      annotated.push({ ...h, marketCap: 'Other' });
    }
  }
  const r = (n) => Math.round(n * 100) / 100;
  return {
    largeCapPct: r(largeCapPct),
    midCapPct: r(midCapPct),
    smallCapPct: r(smallCapPct),
    notClassifiedPct: r(notClassifiedPct),
    annotated,
  };
}

// ---------------------------------------------------------------------------
// Step 1 — load the AMFI ISIN → category map.
// ---------------------------------------------------------------------------

async function loadIsinToCapMap() {
  const map = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('stock_market_cap')
      .select('isin, market_cap_category')
      .range(from, from + 999);
    if (error) throw new Error(`stock_market_cap load failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) map.set(row.isin.toUpperCase(), row.market_cap_category);
    if (data.length < 1000) break;
    from += 1000;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Step 2 — iterate composition rows and re-run the classifier.
// ---------------------------------------------------------------------------

async function processBatch(rows, isinToCap) {
  let updated = 0;
  let flipped = 0; // rows whose source changed 'amfi' <-> 'category_fallback'
  let unchanged = 0;

  for (const row of rows) {
    const holdings = Array.isArray(row.top_holdings) ? row.top_holdings : [];
    if (holdings.length === 0) {
      unchanged += 1;
      continue;
    }

    const cls = classifyHoldings(holdings, isinToCap);
    const total = cls.largeCapPct + cls.midCapPct + cls.smallCapPct;
    const hasCoverage = total > 0;

    // If the classifier gave us no coverage on an existing row, keep the
    // current cap pcts (they're either AMFI-derived from a previous run or
    // category-rules defaults) but flip the source to category_fallback so
    // the UI surfaces a disclaimer. If the row was already
    // category_fallback, leave it alone.
    const newLarge = hasCoverage ? cls.largeCapPct : row.large_cap_pct;
    const newMid = hasCoverage ? cls.midCapPct : row.mid_cap_pct;
    const newSmall = hasCoverage ? cls.smallCapPct : row.small_cap_pct;
    const newNotClass = hasCoverage ? cls.notClassifiedPct : row.not_classified_pct;
    const newSource = hasCoverage ? 'amfi' : 'category_fallback';

    const sourceChanged = newSource !== row.source;
    const numbersChanged =
      newLarge !== row.large_cap_pct ||
      newMid !== row.mid_cap_pct ||
      newSmall !== row.small_cap_pct ||
      newNotClass !== row.not_classified_pct;
    const holdingsChanged = JSON.stringify(cls.annotated) !== JSON.stringify(holdings);

    if (!sourceChanged && !numbersChanged && !holdingsChanged) {
      unchanged += 1;
      continue;
    }
    if (sourceChanged) flipped += 1;

    if (DRY_RUN) {
      console.log(
        '[backfill] DRY scheme=%d date=%s source=%s→%s L=%s→%s M=%s→%s S=%s→%s NC=%s→%s',
        row.scheme_code,
        row.portfolio_date,
        row.source,
        newSource,
        row.large_cap_pct, newLarge,
        row.mid_cap_pct, newMid,
        row.small_cap_pct, newSmall,
        row.not_classified_pct, newNotClass,
      );
      updated += 1;
      continue;
    }

    // The UNIQUE constraint on the table is (scheme_code, portfolio_date,
    // source). When the source flips we can't just UPDATE — the new row
    // might collide with an older one. Delete + insert is safe and
    // idempotent.
    if (sourceChanged) {
      const { error: delErr } = await supabase
        .from('fund_portfolio_composition')
        .delete()
        .eq('id', row.id);
      if (delErr) {
        console.warn('[backfill] delete failed for id=%s: %s', row.id, delErr.message);
        continue;
      }
      const { error: insErr } = await supabase
        .from('fund_portfolio_composition')
        .insert({
          scheme_code: row.scheme_code,
          portfolio_date: row.portfolio_date,
          equity_pct: row.equity_pct,
          debt_pct: row.debt_pct,
          cash_pct: row.cash_pct,
          other_pct: row.other_pct,
          large_cap_pct: newLarge,
          mid_cap_pct: newMid,
          small_cap_pct: newSmall,
          not_classified_pct: newNotClass,
          sector_allocation: row.sector_allocation,
          top_holdings: cls.annotated,
          raw_debt_holdings: row.raw_debt_holdings,
          source: newSource,
          synced_at: new Date().toISOString(),
        });
      if (insErr) {
        console.warn('[backfill] insert failed for scheme=%d: %s', row.scheme_code, insErr.message);
        continue;
      }
    } else {
      const { error } = await supabase
        .from('fund_portfolio_composition')
        .update({
          large_cap_pct: newLarge,
          mid_cap_pct: newMid,
          small_cap_pct: newSmall,
          not_classified_pct: newNotClass,
          top_holdings: cls.annotated,
          synced_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) {
        console.warn('[backfill] update failed for id=%s: %s', row.id, error.message);
        continue;
      }
    }
    updated += 1;
  }

  return { updated, flipped, unchanged };
}

async function main() {
  console.log('[backfill] %sstarting (sources=%s, batch=%d, offset=%d)',
    DRY_RUN ? 'DRY-RUN: ' : '', SOURCE_FILTER.join(','), BATCH_SIZE, START_OFFSET);

  const isinToCap = await loadIsinToCapMap();
  console.log('[backfill] loaded %d ISIN classifications', isinToCap.size);
  if (isinToCap.size === 0) {
    console.error('[backfill] stock_market_cap is empty — run sync-stock-market-cap first');
    process.exit(2);
  }

  let from = START_OFFSET;
  let totalUpdated = 0;
  let totalFlipped = 0;
  let totalUnchanged = 0;
  let totalSeen = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('fund_portfolio_composition')
      .select('id, scheme_code, portfolio_date, source, equity_pct, debt_pct, cash_pct, other_pct, large_cap_pct, mid_cap_pct, small_cap_pct, not_classified_pct, sector_allocation, top_holdings, raw_debt_holdings')
      .in('source', SOURCE_FILTER)
      .order('id', { ascending: true })
      .range(from, from + BATCH_SIZE - 1);
    if (error) {
      console.error('[backfill] page load failed at offset=%d: %s', from, error.message);
      process.exit(3);
    }
    if (!rows || rows.length === 0) break;

    const { updated, flipped, unchanged } = await processBatch(rows, isinToCap);
    totalSeen += rows.length;
    totalUpdated += updated;
    totalFlipped += flipped;
    totalUnchanged += unchanged;

    console.log('[backfill] page offset=%d size=%d → updated=%d flipped=%d unchanged=%d',
      from, rows.length, updated, flipped, unchanged);

    if (rows.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }

  console.log('[backfill] done — seen=%d updated=%d flipped=%d unchanged=%d',
    totalSeen, totalUpdated, totalFlipped, totalUnchanged);
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
