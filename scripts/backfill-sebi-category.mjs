/**
 * backfill-sebi-category.mjs — one-shot offline backfill of
 * scheme_master.sebi_category (+ normalised broad scheme_category) for the
 * existing universe. Run from GitHub Actions (workflow_dispatch) or locally.
 *
 * Why
 * ===
 * The two-field category model (migration 20260529000000) splits the overloaded
 * scheme_category into:
 *   scheme_category  →  broad asset class: Equity | Debt | Hybrid | Other
 *   sebi_category    →  granular SEBI sub-bucket: 'mid cap fund', 'liquid fund', …
 *
 * The migration's in-SQL step already backfilled sebi_category for rows whose
 * scheme_category was *already specific* (a pure lowercase). This script covers
 * the rest — the funds AMFI/mfdata file under the bare "Equity"/"Debt"/"Hybrid"
 * — by deriving the sub-bucket from scheme_name, exactly like the read-time
 * parser the edge functions use. No network calls: it reads scheme_name +
 * scheme_category straight from the DB.
 *
 * The sync-fund-meta cron and fetch-fund-snapshot edge function keep
 * sebi_category fresh going forward; this just heals the existing universe
 * immediately instead of waiting ~7 days for the cron to touch each fund.
 *
 * Pattern table parity
 * ====================
 * deriveSchemeCategoryFromName / isGenericSchemeCategory / resolveSebiCategory /
 * broadCategoryFromSebi below are kept in lock-step with
 * supabase/functions/_shared/portfolio-utils.ts (the unit-tested source of
 * truth). This script can't import the .ts helper from a GitHub Actions runner
 * without a build step — same constraint as scripts/sync-amfi-portfolios.mjs.
 *
 * Required env
 * ============
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (RLS bypass)
 *
 * Optional env
 * ============
 *   BACKFILL_SEBI_DRY_RUN     — '1' to log planned updates without writing
 *   BACKFILL_SEBI_PAGE        — rows per page (default 1000)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[backfill-sebi-category] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DRY_RUN = process.env.BACKFILL_SEBI_DRY_RUN === '1';
const PAGE = Number(process.env.BACKFILL_SEBI_PAGE ?? '1000');

// --- Lock-step copy of _shared/portfolio-utils.ts ---------------------------

// Order matters: longer / more-specific patterns first so "Large & Mid Cap"
// doesn't get classified as "Large Cap".
const NAME_PATTERNS = [
  [['large & mid cap', 'large and mid cap', 'largemidcap', 'large-mid cap'], 'large & mid cap fund'],
  [['multi cap'], 'multi cap fund'],
  [['flexi cap', 'flexicap'], 'flexi cap fund'],
  [['mid cap', 'midcap'], 'mid cap fund'],
  [['small cap', 'smallcap'], 'small cap fund'],
  [['large cap', 'largecap', 'bluechip', 'top 100', 'top 200'], 'large cap fund'],
  [['focused'], 'focused fund'],
  [['contra'], 'contra fund'],
  [['dividend yield'], 'dividend yield fund'],
  [['value'], 'value fund'],
  [['elss', 'tax saver', 'tax plan', 'long term equity', 'long-term equity'], 'elss'],
  [['sectoral', 'thematic', 'banking and financial', 'banking & financial',
    'pharma', 'healthcare', 'technology', 'infrastructure', 'consumption',
    'energy', 'manufacturing', 'business cycle', 'transport', 'logistics',
    'commodities', 'natural resources', 'india opportunities'], 'sectoral/thematic'],
  [['balanced advantage', 'dynamic asset allocation'], 'balanced advantage fund'],
  [['aggressive hybrid'], 'aggressive hybrid fund'],
  [['conservative hybrid'], 'conservative hybrid fund'],
  [['equity savings'], 'equity savings fund'],
  [['multi asset'], 'multi asset allocation'],
  [['balanced hybrid'], 'balanced hybrid fund'],
  [['arbitrage'], 'arbitrage fund'],
  [['fund of fund', 'fund of funds', 'fof'], 'fund of funds domestic'],
  [['etf', ' bees'], 'other etfs'],
  [['index fund', 'nifty', 'sensex', ' bse '], 'index funds'],
  [['overnight'], 'overnight fund'],
  [['liquid'], 'liquid fund'],
  [['ultra short'], 'ultra short duration fund'],
  [['low duration'], 'low duration fund'],
  [['money market'], 'money market fund'],
  [['short duration', 'short term'], 'short duration fund'],
  [['medium to long duration'], 'medium to long duration'],
  [['medium duration'], 'medium duration fund'],
  [['long duration'], 'long duration fund'],
  [['dynamic bond'], 'dynamic bond fund'],
  [['corporate bond'], 'corporate bond fund'],
  [['credit risk'], 'credit risk fund'],
  [['banking and psu', 'banking & psu'], 'banking and psu fund'],
  [['gilt'], 'gilt fund'],
  [['floater', 'floating rate'], 'floater fund'],
  [['retirement'], 'solution oriented - retirement'],
  [["children's", 'childrens', 'children'], 'solution oriented - childrens'],
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

// --- Backfill ---------------------------------------------------------------

async function main() {
  console.log(
    `[backfill-sebi-category] start — dry_run=${DRY_RUN} page=${PAGE}`,
  );

  let scanned = 0;
  let alreadySet = 0;
  let resolved = 0;
  let broadNormalised = 0;
  let unresolved = 0;
  let failed = 0;
  let from = 0;

  // Page the full table by stable scheme_code offset and skip rows that
  // already have sebi_category (the migration filled the already-specific
  // ones). Paging the whole table — rather than filtering on `sebi_category IS
  // NULL` — keeps the offset window stable as live updates fill the column;
  // a null-filtered query would shift rows under us and skip the unresolved
  // remainder. Ordering on the primary key is unaffected by non-key updates.
  for (;;) {
    const { data, error } = await supabase
      .from('scheme_master')
      .select('scheme_code, scheme_name, scheme_category, sebi_category')
      .order('scheme_code', { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error('[backfill-sebi-category] read failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      if (row.sebi_category) { alreadySet++; continue; } // resolved by migration / prior sync
      const sebi = resolveSebiCategory(row.scheme_category, row.scheme_name);
      if (!sebi) {
        unresolved++;
        continue;
      }

      const update = { sebi_category: sebi };
      const broad = broadCategoryFromSebi(sebi);
      if (broad && broad !== row.scheme_category) {
        update.scheme_category = broad;
        broadNormalised++;
      }

      if (DRY_RUN) {
        resolved++;
        if (resolved <= 20) {
          console.log(
            `[dry-run] ${row.scheme_code} "${row.scheme_name}" → sebi="${sebi}"` +
              (update.scheme_category ? ` broad="${update.scheme_category}"` : ''),
          );
        }
        continue;
      }

      const { error: upErr } = await supabase
        .from('scheme_master')
        .update(update)
        .eq('scheme_code', row.scheme_code);
      if (upErr) {
        console.error(`[backfill-sebi-category] ${row.scheme_code} update failed:`, upErr.message);
        failed++;
      } else {
        resolved++;
      }
    }

    from += PAGE;
    if (data.length < PAGE) break;
  }

  console.log(
    `[backfill-sebi-category] done — scanned=${scanned} already_set=${alreadySet} ` +
      `resolved=${resolved} broad_normalised=${broadNormalised} unresolved=${unresolved} failed=${failed}`,
  );
  if (unresolved > 0) {
    console.log(
      `[backfill-sebi-category] ${unresolved} rows left NULL (name didn't disambiguate) — ` +
        `read-time name parser keeps covering these until a fresh sync arrives.`,
    );
  }
}

main().catch((err) => {
  console.error('[backfill-sebi-category] fatal:', err);
  process.exit(1);
});
