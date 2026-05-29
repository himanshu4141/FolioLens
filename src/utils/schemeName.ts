/**
 * Pure helpers for AMFI scheme name handling. Lives in its own file so tests
 * don't have to drag in supabase / react-native via fundSearch.ts.
 */

/**
 * Trim AMFI plan/option suffixes off a scheme name for compact display.
 * Used by the universal fund picker rows and the Compare Funds chip / hero
 * labels.
 */
export function shortSchemeName(name: string): string {
  return name
    .trim()
    .replace(/\s+-\s+(Direct|Regular)\s+Plan(\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?)?$/i, '')
    .replace(/\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?$/i, '')
    .trim();
}

/**
 * Human-readable labels for the canonical lowercase SEBI keys persisted in
 * `scheme_master.sebi_category`. The Compare screen reads this authoritative
 * value directly — there is no client-side name parsing — so this map only
 * needs to prettify the keys the UI commonly shows. Anything not listed is
 * title-cased from the raw key, and a NULL `sebi_category` falls back to the
 * broad asset class.
 */
const SEBI_KEY_LABELS: Record<string, string> = {
  'large & mid cap fund': 'Large & Mid Cap',
  'flexi cap fund': 'Flexi Cap',
  'multi cap fund': 'Multi Cap',
  'small cap fund': 'Small Cap',
  'mid cap fund': 'Mid Cap',
  'large cap fund': 'Large Cap',
  'elss': 'ELSS',
  'focused fund': 'Focused',
  'dividend yield fund': 'Dividend Yield',
  'contra fund': 'Contra',
  'value fund': 'Value',
  'sectoral/thematic': 'Sectoral / Thematic',
};

/**
 * Title-case a raw canonical SEBI key for display when it isn't in the curated
 * label map above (e.g. `"liquid fund"` → `"Liquid Fund"`).
 */
function titleCaseSebiKey(key: string): string {
  return key
    .split(/\s+/)
    .map((word) => (word.length ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * The category used to label a fund and to decide whether two funds are
 * "directly comparable" (the Compare Funds cross-category banner).
 *
 * Reads the AUTHORITATIVE `scheme_master.sebi_category` — the persisted granular
 * SEBI sub-bucket written by the sync edge functions + backfill
 * (`resolveSebiCategory` / `deriveSchemeCategoryFromName`) — and maps it to a
 * display label. There is deliberately NO client-side name parsing: category
 * resolution lives in exactly one place (the data pipeline), so the app can
 * never disagree with its own source of truth.
 *
 * When `sebi_category` is still NULL (a fund not yet synced / backfilled) we
 * fall back to the broad asset class (`scheme_category`: Equity / Debt / Hybrid
 * / Other) — coarser, but still authoritative — rather than guessing from the
 * name.
 *
 * Returns a stable, human-readable label suitable for the banner copy.
 */
export function fundComparisonCategory(
  sebiCategory: string | null | undefined,
  broadCategory: string | null | undefined,
): string {
  if (sebiCategory) {
    const key = sebiCategory.toLowerCase().trim();
    if (key) return SEBI_KEY_LABELS[key] ?? titleCaseSebiKey(key);
  }
  return broadCategory ?? 'Other';
}
