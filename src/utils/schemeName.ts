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
 * Resolve the category used to decide whether two funds are "directly
 * comparable" (e.g. the Compare Funds cross-category banner).
 *
 * `scheme_master.scheme_category` is only the broad SEBI class
 * (Equity / Debt / Hybrid / Other) for CAS-imported holdings, so it can't tell
 * a Large Cap fund from a Mid Cap fund — they're all "Equity". AMFI scheme
 * names, however, almost always embed the SEBI sub-category ("… Large Cap
 * Fund", "… Flexi Cap Fund"). We parse that from the name and fall back to the
 * broad category when nothing matches.
 *
 * Returns a stable, human-readable label suitable for the banner copy.
 */
export function fundComparisonCategory(
  schemeName: string,
  broadCategory: string | null,
): string {
  // The cap/style sub-categories below only apply to equity funds. For Debt /
  // Hybrid / Other the broad class is the right comparison unit, and parsing
  // names there would misfire (e.g. "Banking & PSU Debt Fund").
  if (broadCategory && !/equity/i.test(broadCategory)) return broadCategory;

  const n = schemeName.toLowerCase();

  // Order matters: more specific phrases first so "Large & Mid Cap" doesn't
  // get swallowed by the "Large Cap" / "Mid Cap" rules below.
  if (/large\s*(&|and)\s*mid\s*cap/.test(n)) return 'Large & Mid Cap';
  if (/flexi[\s-]*cap/.test(n)) return 'Flexi Cap';
  if (/multi[\s-]*cap/.test(n)) return 'Multi Cap';
  if (/small[\s-]*cap/.test(n)) return 'Small Cap';
  if (/mid[\s-]*cap/.test(n)) return 'Mid Cap';
  if (/large[\s-]*cap|blue[\s-]*chip|top\s*(100|200)\b/.test(n)) return 'Large Cap';
  if (/elss|tax\s*saver|tax\s*saving|long\s*term\s*equity/.test(n)) return 'ELSS';
  if (/focused/.test(n)) return 'Focused';
  if (/dividend\s*yield/.test(n)) return 'Dividend Yield';
  if (/\bcontra\b/.test(n)) return 'Contra';
  if (/\bvalue\b/.test(n)) return 'Value';
  if (/intern?ational|\bglobal\b|overseas|\bus\s|nasdaq|\bworld\b/.test(n)) return 'International';
  // Sector & thematic funds rarely say "sectoral"/"thematic" in the name —
  // they name the sector directly. Catch the common ones.
  if (
    /sectoral|thematic|technology|\bdigital\b|pharma|health\s*care|healthcare|\bbank|financial\s*services|\binfra|infrastructure|consumption|\bconsumer|\benergy\b|\bpower\b|fmcg|\bauto\b|realty|real\s*estate|\bpsu\b|\bmnc\b|commodit|natural\s*resource|manufactur|transport|logistics/.test(n)
  ) {
    return 'Sectoral / Thematic';
  }

  // No SEBI equity sub-category in the name — fall back to the broad class.
  return broadCategory ?? 'Other';
}
