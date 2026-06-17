/**
 * Pure helpers for AMFI scheme name handling. Lives in its own file so tests
 * don't have to drag in supabase / react-native via fundSearch.ts.
 */

/**
 * Trim AMFI plan/option suffixes off a scheme name for compact display.
 *
 * FALLBACK ONLY — used when `scheme_master.family_name` is NULL (inactive
 * registry shells that OpenFolio doesn't index). For all actively-synced
 * schemes, prefer `family_name` directly from the DB (populated by
 * universe-backfill + sync-fund-meta from the OF /v1/metadata endpoint).
 *
 * Client-side regex parsing is kept as a last resort because the canonical
 * " - Direct Plan - Growth" shape it targets covers ~80 % of the long-tail
 * inactive shells, but it fails for non-canonical AMFI names such as:
 *   "BANK OF INDIA … Fund Direct Plan-Growth"  (hyphen without spaces)
 *   "… Fund -Direct - IDCW"                    (leading hyphen, no "Plan")
 * Those edge cases are acceptable for inactive shells; they are not shown for
 * any fund OF indexes (which is all active schemes).
 */
export function shortSchemeName(name: string): string {
  return name
    .trim()
    .replace(/\s+-\s+(Direct|Regular)\s+Plan(\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?)?$/i, '')
    .replace(/\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?$/i, '')
    .trim();
}

const PLAN_TYPE_LABELS: Record<string, string> = {
  direct: 'Direct',
  regular: 'Regular',
};

const OPTION_TYPE_LABELS: Record<string, string> = {
  growth: 'Growth',
  idcw_payout: 'IDCW',
  idcw_reinvest: 'IDCW Reinvest',
  idcw: 'IDCW',
  dividend_payout: 'IDCW',
  dividend_reinvest: 'IDCW Reinvest',
  bonus: 'Bonus',
};

/**
 * Format a compact "Direct · Growth" label from the OF-sourced plan_type and
 * option_type columns. Returns null when both fields are absent (e.g. inactive
 * registry shells without OF metadata).
 */
export function planOptionLabel(
  planType: string | null | undefined,
  optionType: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (planType) {
    const key = planType.toLowerCase().trim();
    parts.push(PLAN_TYPE_LABELS[key] ?? planType);
  }
  if (optionType) {
    const key = optionType.toLowerCase().trim();
    parts.push(OPTION_TYPE_LABELS[key] ?? optionType);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
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
