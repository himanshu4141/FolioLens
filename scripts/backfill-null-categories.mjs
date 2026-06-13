/**
 * backfill-null-categories.mjs — Layer 1 + Layer 2 one-off fix for the
 * 1,033 active scheme_master rows that have both scheme_category and
 * sebi_category as NULL.
 *
 * Layer 1 — sibling inheritance
 *   For each null-category scheme, look for another active scheme_master row
 *   in the same AMC that (a) shares the same fund-family base name after
 *   stripping plan/option suffixes and (b) already has both categories set.
 *   If exactly one {sebi_category, scheme_category} pair is found across all
 *   matching siblings, copy it.  Skip when siblings disagree (ambiguous family)
 *   or when no categorised sibling exists.
 *
 *   Assumption: category is a family-level fact — all plan/option variants
 *   of the same fund (Direct/Regular, Growth/IDCW, Daily/Weekly IDCW …) belong
 *   to the same SEBI sub-bucket and broad asset class.
 *
 * Layer 2 — extended name heuristics
 *   Re-runs resolveSebiCategory (with the updated pattern table from
 *   portfolio-utils.ts) over all remaining null-category rows.  This covers
 *   new patterns added since the last backfill-sebi-category.mjs run:
 *   multi-cap (hyphen), government securities → gilt, equity hybrid → aggressive
 *   hybrid, money manager → money market, medium term → medium duration, etc.
 *
 * Architecture choice — one-off script vs edge-function patch
 *   Layer 1 is also wired into universe-backfill's metadata phase (see the
 *   applyMetadataSiblingInheritance helper) so future plan aliases are
 *   categorised at sync time.  Running a one-off script here heals the
 *   existing 1,033 rows immediately without waiting for the next monthly
 *   backfill cycle.  Layer 2 is a pure DB read+write with no external I/O,
 *   so a script is simpler than an edge function and easier to verify.
 *
 * Required env
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (RLS bypass)
 *
 * Optional env
 *   BACKFILL_DRY_RUN   — '1' to log without writing
 *   BACKFILL_PAGE_SIZE — rows per page (default 500)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[backfill-null-categories] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.env.BACKFILL_DRY_RUN === '1';
const PAGE_SIZE = Number(process.env.BACKFILL_PAGE_SIZE ?? '500');

// ── Name normalisation (lock-step copy of portfolio-utils.ts) ─────────────
// The .ts file is the source of truth; this is an inlined JS copy since
// .mjs scripts can't import TypeScript files without a build step.

/**
 * Strips plan/option suffixes from an AMFI scheme name to get the fund-family
 * base name used for sibling matching.
 */
function normaliseSchemeName(name) {
  return name
    .trim()
    // 1. Strip "- {plan_type} [Plan] [sep] {option}…" from the end.
    .replace(
      /\s*-+\s*(?:direct|regular|dir)(?:\s+plan)?\s*(?:[-–]\s*|\s+)?(?:growth|idcw|income distribution|dividend|payout|reinvest|daily|weekly|monthly|quarterly|half\s*yearly|annual|standard|periodic|plan).*$/i,
      '',
    )
    // 2. Strip bare "- {option}…" suffix (no plan keyword).
    .replace(
      /\s*-+\s*(?:growth|idcw|income distribution|dividend|payout|reinvest|daily|weekly|monthly|quarterly|half\s*yearly|annual|standard|periodic).*$/i,
      '',
    )
    // 3. Strip trailing bare plan type "- Direct [Plan]" / "- Regular [Plan]".
    .replace(/\s*-+\s*(?:direct|regular|dir)(?:\s+plan)?\s*$/i, '')
    .trim()
    .toLowerCase();
}

// ── Category pattern table (lock-step with portfolio-utils.ts) ─────────────

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

// ── Acceptance SQL helper ──────────────────────────────────────────────────

async function countNullCategoriesExact() {
  // PostgREST count=exact via head:true gives count in .count property
  const res = await supabase
    .from('scheme_master')
    .select('*', { count: 'exact', head: true })
    .eq('scheme_active', true)
    .is('scheme_category', null)
    .is('sebi_category', null);
  return res.count ?? 0;
}

// ── Layer 1: sibling inheritance ───────────────────────────────────────────

async function runSiblingInheritance(nullRows, siblingPool) {
  // Build index: amc_name → categorised rows
  const siblingsByAmc = new Map();
  for (const s of siblingPool) {
    const amc = (s.amc_name ?? '').toLowerCase().trim();
    if (!siblingsByAmc.has(amc)) siblingsByAmc.set(amc, []);
    siblingsByAmc.get(amc).push(s);
  }

  let inherited = 0;
  let skippedNoSibling = 0;
  let skippedAmbiguous = 0;

  for (const row of nullRows) {
    const targetBase = normaliseSchemeName(row.scheme_name);
    const targetAmc = (row.amc_name ?? '').toLowerCase().trim();
    const candidates = siblingsByAmc.get(targetAmc) ?? [];

    // Find same-family categorised siblings
    const matches = candidates.filter(
      (c) =>
        c.scheme_code !== row.scheme_code &&
        normaliseSchemeName(c.scheme_name) === targetBase,
    );

    if (matches.length === 0) { skippedNoSibling++; continue; }

    // Collect distinct {sebi_category, scheme_category} pairs
    const pairs = new Map();
    for (const m of matches) {
      const key = `${m.sebi_category}|||${m.scheme_category}`;
      if (!pairs.has(key)) pairs.set(key, { sebi_category: m.sebi_category, scheme_category: m.scheme_category });
    }

    if (pairs.size !== 1) { skippedAmbiguous++; continue; } // ambiguous family

    const pair = [...pairs.values()][0];

    if (DRY_RUN) {
      if (inherited < 10) {
        console.log(
          `[dry-run L1] ${row.scheme_code} "${row.scheme_name.slice(0, 60)}"` +
            ` → sebi="${pair.sebi_category}" broad="${pair.scheme_category}"`,
        );
      }
      inherited++;
      continue;
    }

    const { error } = await supabase
      .from('scheme_master')
      .update({ sebi_category: pair.sebi_category, scheme_category: pair.scheme_category })
      .eq('scheme_code', row.scheme_code)
      .is('sebi_category', null)
      .is('scheme_category', null);

    if (error) {
      console.error(`[L1] ${row.scheme_code} update failed: ${error.message}`);
    } else {
      inherited++;
    }
  }

  return { inherited, skippedNoSibling, skippedAmbiguous };
}

// ── Layer 2: name heuristics ───────────────────────────────────────────────

async function runNameHeuristics(nullRows) {
  let resolved = 0;
  let broadNormalised = 0;
  let unresolved = 0;

  for (const row of nullRows) {
    const sebi = resolveSebiCategory(row.scheme_category, row.scheme_name);
    if (!sebi) { unresolved++; continue; }

    const broad = broadCategoryFromSebi(sebi);
    const update = { sebi_category: sebi };
    if (broad) {
      update.scheme_category = broad;
      broadNormalised++;
    }

    if (DRY_RUN) {
      if (resolved < 10) {
        console.log(
          `[dry-run L2] ${row.scheme_code} "${row.scheme_name.slice(0, 60)}"` +
            ` → sebi="${sebi}"${update.scheme_category ? ` broad="${update.scheme_category}"` : ''}`,
        );
      }
      resolved++;
      continue;
    }

    const { error } = await supabase
      .from('scheme_master')
      .update(update)
      .eq('scheme_code', row.scheme_code)
      .is('sebi_category', null)
      .is('scheme_category', null);

    if (error) {
      console.error(`[L2] ${row.scheme_code} update failed: ${error.message}`);
    } else {
      resolved++;
    }
  }

  return { resolved, broadNormalised, unresolved };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill-null-categories] start — dry_run=${DRY_RUN} page_size=${PAGE_SIZE}`);

  const before = await countNullCategoriesExact();
  console.log(`[backfill-null-categories] null-category active schemes BEFORE: ${before}`);

  // Load all null-category active schemes (paged to avoid large memory use)
  const nullRows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('scheme_master')
      .select('scheme_code, scheme_name, amc_name, scheme_category, sebi_category')
      .eq('scheme_active', true)
      .is('scheme_category', null)
      .is('sebi_category', null)
      .order('scheme_code', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) { console.error('Failed to load null rows:', error.message); process.exit(1); }
    if (!data?.length) break;
    nullRows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  console.log(`[backfill-null-categories] loaded ${nullRows.length} null-category rows`);

  // Load all categorised active schemes (sibling pool for Layer 1)
  const siblingPool = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('scheme_master')
      .select('scheme_code, scheme_name, amc_name, scheme_category, sebi_category')
      .eq('scheme_active', true)
      .not('sebi_category', 'is', null)
      .not('scheme_category', 'is', null)
      .order('scheme_code', { ascending: true })
      .range(from, from + 999);

    if (error) { console.error('Failed to load sibling pool:', error.message); process.exit(1); }
    if (!data?.length) break;
    siblingPool.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`[backfill-null-categories] sibling pool: ${siblingPool.length} categorised rows`);

  // ── Layer 1 ──
  console.log('\n[backfill-null-categories] === Layer 1: sibling inheritance ===');
  const l1 = await runSiblingInheritance(nullRows, siblingPool);
  console.log(
    `[backfill-null-categories] L1 done — inherited=${l1.inherited}` +
      ` skipped_no_sibling=${l1.skippedNoSibling} skipped_ambiguous=${l1.skippedAmbiguous}`,
  );

  // For live runs, re-fetch null rows so Layer 2 only processes the residue.
  let l2InputRows = nullRows;
  if (!DRY_RUN && l1.inherited > 0) {
    l2InputRows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data } = await supabase
        .from('scheme_master')
        .select('scheme_code, scheme_name, amc_name, scheme_category, sebi_category')
        .eq('scheme_active', true)
        .is('scheme_category', null)
        .is('sebi_category', null)
        .order('scheme_code', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (!data?.length) break;
      l2InputRows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
    console.log(`[backfill-null-categories] null residue after L1: ${l2InputRows.length}`);
  }

  // ── Layer 2 ──
  console.log('\n[backfill-null-categories] === Layer 2: name heuristics ===');
  const l2 = await runNameHeuristics(l2InputRows);
  console.log(
    `[backfill-null-categories] L2 done — resolved=${l2.resolved}` +
      ` broad_normalised=${l2.broadNormalised} unresolved=${l2.unresolved}`,
  );

  const after = DRY_RUN ? before : await countNullCategoriesExact();
  console.log(`\n[backfill-null-categories] null-category active schemes AFTER : ${after}`);
  console.log(
    `[backfill-null-categories] fixed=${before - after}` +
      ` remaining=${after} (target: <300 after Layer 3 mfdata sweep)`,
  );

  if (!DRY_RUN && after > 300) {
    console.log(
      '[backfill-null-categories] NOTE: run scripts/mfdata-category-sweep.mjs to resolve' +
        ' the remaining schemes via mfdata.in (Layer 3).',
    );
  }
}

main().catch((err) => {
  console.error('[backfill-null-categories] fatal:', err);
  process.exit(1);
});
