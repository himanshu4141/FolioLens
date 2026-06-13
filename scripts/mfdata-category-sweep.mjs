/**
 * mfdata-category-sweep.mjs — Layer 3 one-off fix for active scheme_master
 * rows that still have both scheme_category and sebi_category as NULL after
 * running backfill-null-categories.mjs (Layer 1 + Layer 2).
 *
 * For each null-category scheme it calls mfdata.in to get the fund's
 * "category" field, then maps it through the same resolveSebiCategory /
 * broadCategoryFromSebi logic used by sync-fund-meta.  Rate-limited at 300 ms
 * between requests (same cadence as sync-fund-meta's INTER_SCHEME_DELAY_MS).
 *
 * Run order: after backfill-null-categories.mjs, before declaring the fix done.
 *   node scripts/backfill-null-categories.mjs  → Layer 1 + 2
 *   node scripts/mfdata-category-sweep.mjs     → Layer 3 (this file)
 *
 * Required env
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (RLS bypass)
 *
 * Optional env
 *   BACKFILL_DRY_RUN     — '1' to log without writing
 *   MFDATA_SWEEP_RESUME  — scheme_code to resume from (skip codes below this)
 *   MFDATA_DELAY_MS      — inter-request delay in ms (default 300)
 *   MFDATA_PAGE_SIZE     — rows per load page (default 500)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[mfdata-category-sweep] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.env.BACKFILL_DRY_RUN === '1';
const RESUME_FROM = process.env.MFDATA_SWEEP_RESUME
  ? Number(process.env.MFDATA_SWEEP_RESUME)
  : 0;
const DELAY_MS = Number(process.env.MFDATA_DELAY_MS ?? '300');
const PAGE_SIZE = Number(process.env.MFDATA_PAGE_SIZE ?? '500');

const MFDATA_USER_AGENT = 'Mozilla/5.0 (compatible; FolioLens/1.0; +https://foliolens.app)';
const FETCH_TIMEOUT_MS = 20_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Category resolution (lock-step copy of portfolio-utils.ts) ────────────
// The .ts file is the source of truth; this is an inlined JS copy since
// .mjs scripts can't import TypeScript files without a build step.

const NAME_PATTERNS = [
  [['large & mid cap', 'large and mid cap', 'largemidcap', 'large-mid cap'], 'large & mid cap fund'],
  [['multi cap', 'multi-cap', 'multicap'], 'multi cap fund'],
  [['flexi cap', 'flexicap'], 'flexi cap fund'],
  [['mid cap', 'midcap'], 'mid cap fund'],
  [['small cap', 'smallcap'], 'small cap fund'],
  [['large cap', 'largecap', 'bluechip', 'top 100', 'top 200'], 'large cap fund'],
  [['focused'], 'focused fund'],
  [['contra'], 'contra fund'],
  [['dividend yield'], 'dividend yield fund'],
  [['value'], 'value fund'],
  [['elss', 'tax saver', 'tax plan', 'tax savings', 'long term equity', 'long-term equity'], 'elss'],
  // banking and psu BEFORE sectoral/thematic to prevent 'psu' false-positive
  [['banking and psu', 'banking & psu'], 'banking and psu fund'],
  [['sectoral', 'thematic', 'banking and financial', 'banking & financial',
    'pharma', 'healthcare', 'technology', 'infrastructure', 'consumption',
    'energy', 'manufacturing', 'business cycle', 'transport', 'logistics',
    'commodities', 'natural resources', 'india opportunities',
    'momentum', 'innovation', 'esg', 'ethical', 'sustainability',
    'financial services', 'special opportunities', 'psu'], 'sectoral/thematic'],
  [['balanced advantage', 'dynamic asset allocation'], 'balanced advantage fund'],
  [['aggressive hybrid', 'equity hybrid', 'hybrid equity'], 'aggressive hybrid fund'],
  [['conservative hybrid'], 'conservative hybrid fund'],
  [['equity savings'], 'equity savings fund'],
  [['multi asset'], 'multi asset allocation'],
  [['balanced hybrid', 'balanced hyrbrid'], 'balanced hybrid fund'],
  [['arbitrage'], 'arbitrage fund'],
  [['fund of fund', 'fund of funds', 'fof'], 'fund of funds domestic'],
  [['etf', ' bees'], 'other etfs'],
  [['gold fund'], 'fund of funds domestic'],
  [['index fund', 'nifty', 'sensex', ' bse '], 'index funds'],
  [['overnight'], 'overnight fund'],
  [['liquid'], 'liquid fund'],
  [['ultra short'], 'ultra short duration fund'],
  [['low duration'], 'low duration fund'],
  [['money market', 'money manager'], 'money market fund'],
  [['short duration', 'short term'], 'short duration fund'],
  [['medium to long duration'], 'medium to long duration'],
  [['medium duration', 'medium term'], 'medium duration fund'],
  [['long duration', 'long term bond'], 'long duration fund'],
  [['strategic bond', 'dynamic bond'], 'dynamic bond fund'],
  [['corporate bond'], 'corporate bond fund'],
  [['credit risk'], 'credit risk fund'],
  [['gilt', 'government securities', 'government bond', 'govt securities', 'govenment securities'], 'gilt fund'],
  [['floater', 'floating rate'], 'floater fund'],
  [['retirement'], 'solution oriented - retirement'],
  [["children's", 'childrens', 'children', 'bal bhavishya'], 'solution oriented - childrens'],
];

function deriveSchemeCategoryFromName(schemeName) {
  if (!schemeName) return null;
  const name = schemeName.toLowerCase();
  for (const [needles, key] of NAME_PATTERNS) {
    if (needles.some((n) => name.includes(n))) return key;
  }
  return null;
}

function isGenericSchemeCategory(schemeCategory) {
  if (!schemeCategory) return true;
  const key = String(schemeCategory).toLowerCase().trim();
  return key === 'equity' || key === 'debt' || key === 'hybrid' || key === 'other' || key === '';
}

function resolveSebiCategory(schemeCategory, schemeName) {
  if (!isGenericSchemeCategory(schemeCategory)) {
    return String(schemeCategory).toLowerCase().trim();
  }
  return deriveSchemeCategoryFromName(schemeName);
}

const BROAD_EQUITY = new Set([
  'large cap fund', 'mid cap fund', 'small cap fund', 'multi cap fund',
  'flexi cap fund', 'large & mid cap fund', 'elss', 'value fund',
  'contra fund', 'focused fund', 'sectoral/thematic', 'dividend yield fund',
  'index funds', 'other etfs',
]);
const BROAD_HYBRID = new Set([
  'aggressive hybrid fund', 'balanced hybrid fund', 'conservative hybrid fund',
  'balanced advantage fund', 'dynamic asset allocation', 'multi asset allocation',
  'equity savings fund', 'arbitrage fund', 'fund of funds domestic',
  'solution oriented - retirement', 'solution oriented - childrens',
]);
const BROAD_DEBT = new Set([
  'overnight fund', 'liquid fund', 'ultra short duration fund', 'low duration fund',
  'money market fund', 'short duration fund', 'medium duration fund',
  'medium to long duration', 'long duration fund', 'dynamic bond fund',
  'corporate bond fund', 'credit risk fund', 'banking and psu fund', 'gilt fund',
  'floater fund',
]);

function broadCategoryFromSebi(sebiKey) {
  if (!sebiKey) return null;
  const key = String(sebiKey).toLowerCase().trim();
  if (BROAD_EQUITY.has(key)) return 'Equity';
  if (BROAD_HYBRID.has(key)) return 'Hybrid';
  if (BROAD_DEBT.has(key)) return 'Debt';
  if (key === 'fund of funds investing overseas') return 'Other';
  return null;
}

// ── mfdata fetch ──────────────────────────────────────────────────────────

async function fetchMFDataScheme(schemeCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://mfdata.in/api/v1/schemes/${schemeCode}`, {
      headers: { 'User-Agent': MFDATA_USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // mfdata wraps response: { status, data: { ... } } or bare payload
    return 'data' in body ? (body.data ?? null) : (body ?? null);
  } finally {
    clearTimeout(timer);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────

async function countNullCategoriesExact() {
  const res = await supabase
    .from('scheme_master')
    .select('*', { count: 'exact', head: true })
    .eq('scheme_active', true)
    .is('scheme_category', null)
    .is('sebi_category', null);
  return res.count ?? 0;
}

async function loadNullRows() {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('scheme_master')
      .select('scheme_code, scheme_name, amc_name, scheme_category, sebi_category')
      .eq('scheme_active', true)
      .is('scheme_category', null)
      .is('sebi_category', null)
      .order('scheme_code', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('[mfdata-category-sweep] failed to load null rows:', error.message);
      process.exit(1);
    }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[mfdata-category-sweep] start — dry_run=${DRY_RUN} delay_ms=${DELAY_MS}` +
      (RESUME_FROM ? ` resume_from=${RESUME_FROM}` : ''),
  );

  const before = await countNullCategoriesExact();
  console.log(`[mfdata-category-sweep] null-category active schemes BEFORE: ${before}`);

  const allNullRows = await loadNullRows();
  const rows = RESUME_FROM
    ? allNullRows.filter((r) => r.scheme_code >= RESUME_FROM)
    : allNullRows;

  console.log(
    `[mfdata-category-sweep] loaded ${allNullRows.length} null-category rows` +
      (RESUME_FROM ? `, processing ${rows.length} (resumed from ${RESUME_FROM})` : ''),
  );

  let resolved = 0;
  let mfdataResolved = 0; // resolved via mfdata.category (not just name heuristics)
  let nameResolved = 0;   // resolved via name heuristics on mfdata schemeName fall-through
  let unresolved = 0;
  let fetchErrors = 0;
  let writeErrors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Progress log every 50 schemes
    if (i > 0 && i % 50 === 0) {
      console.log(
        `[mfdata-category-sweep] progress: ${i}/${rows.length}` +
          ` resolved=${resolved} unresolved=${unresolved} errors=${fetchErrors}`,
      );
    }

    await delay(DELAY_MS);

    let mfdata = null;
    try {
      mfdata = await fetchMFDataScheme(row.scheme_code);
    } catch (err) {
      console.warn(
        `[mfdata-category-sweep] ${row.scheme_code} fetch error: ${err.message}`,
      );
      fetchErrors++;
    }

    // Resolve via mfdata.category (if specific) then fall through to name heuristics.
    // Mirrors sync-fund-meta's category resolution block exactly.
    const mfdataCategory = mfdata?.category ?? null;
    const sebi = resolveSebiCategory(mfdataCategory, row.scheme_name);

    if (!sebi) {
      if (mfdata !== null) {
        // mfdata responded but gave no usable category
        console.log(
          `[mfdata-category-sweep] ${row.scheme_code} unresolved` +
            ` (mfdata.category=${JSON.stringify(mfdataCategory)} name="${row.scheme_name?.slice(0, 50)}")`,
        );
      }
      unresolved++;
      continue;
    }

    const broad = broadCategoryFromSebi(sebi);
    const usedMfdataCategory =
      mfdataCategory != null && !isGenericSchemeCategory(mfdataCategory);

    if (DRY_RUN) {
      if (resolved < 20) {
        console.log(
          `[dry-run L3] ${row.scheme_code} "${row.scheme_name?.slice(0, 55)}"` +
            ` → sebi="${sebi}"${broad ? ` broad="${broad}"` : ''}` +
            ` (src=${usedMfdataCategory ? 'mfdata.category' : 'name-heuristic'})`,
        );
      }
      resolved++;
      if (usedMfdataCategory) mfdataResolved++; else nameResolved++;
      continue;
    }

    const update = { sebi_category: sebi };
    if (broad) update.scheme_category = broad;

    const { error } = await supabase
      .from('scheme_master')
      .update(update)
      .eq('scheme_code', row.scheme_code)
      .is('sebi_category', null)
      .is('scheme_category', null);

    if (error) {
      console.error(`[mfdata-category-sweep] ${row.scheme_code} write error: ${error.message}`);
      writeErrors++;
    } else {
      resolved++;
      if (usedMfdataCategory) mfdataResolved++; else nameResolved++;
    }
  }

  const after = DRY_RUN ? before : await countNullCategoriesExact();

  console.log('\n[mfdata-category-sweep] === summary ===');
  console.log(`  BEFORE : ${before}`);
  console.log(`  AFTER  : ${after}`);
  console.log(`  fixed  : ${before - after}`);
  console.log(`  resolved via mfdata.category : ${mfdataResolved}`);
  console.log(`  resolved via name heuristics : ${nameResolved}`);
  console.log(`  unresolved                   : ${unresolved}`);
  console.log(`  fetch errors                 : ${fetchErrors}`);
  console.log(`  write errors                 : ${writeErrors}`);
  if (after > 0) {
    console.log(`\n[mfdata-category-sweep] ${after} schemes remain uncategorised.`);
    console.log(
      '  These funds likely have no mfdata record and no recognisable name pattern.',
    );
    console.log(
      '  Inspect with: SELECT scheme_code, scheme_name FROM scheme_master',
    );
    console.log(
      '                WHERE scheme_active AND sebi_category IS NULL AND scheme_category IS NULL',
    );
    console.log('                ORDER BY scheme_code;');
  }
}

main().catch((err) => {
  console.error('[mfdata-category-sweep] fatal:', err);
  process.exit(1);
});
