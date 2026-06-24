/**
 * Pure utility functions for fund portfolio composition logic.
 * Extracted to _shared/ so they can be tested under Jest (no Deno deps).
 */

export interface CategoryComposition {
  equity: number;
  debt: number;
  cash: number;
  other: number;
  large: number;
  mid: number;
  small: number;
}

export interface DebtHolding {
  holding_type?: string;
  credit_rating?: string;
  weight_pct?: number;
}

export interface EquityHolding {
  stock_name?: string;
  isin?: string | null;
  sector?: string | null;
  weight_pct?: number;
}

/** Returns true if value is a numeric string (e.g. "-14.30", "23.23"). */
export function isNumericString(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * Returns true if the debt_holdings array is corrupted.
 *
 * Some fund families (confirmed: pure-equity large-cap and overseas funds)
 * have benchmark performance data injected into debt_holdings with numeric
 * strings as holding_type or credit_rating. Discard the entire array when
 * this pattern is detected rather than silently computing a wrong debt_pct.
 */
export function isDebtDataCorrupted(debtHoldings: DebtHolding[]): boolean {
  return debtHoldings.some(
    (h) => isNumericString(h.holding_type) || isNumericString(h.credit_rating),
  );
}

/** Sum weight_pct across all debt holdings to derive debt_pct. */
export function deriveDebtPct(debtHoldings: DebtHolding[]): number {
  return debtHoldings.reduce((sum, h) => sum + (h.weight_pct ?? 0), 0);
}

/**
 * Returns false if equity_pct is obviously wrong for the given category rules.
 *
 * Two guards:
 *   1. Pure equity funds (catRules.equity >= 80): reject if equity_pct < 50.
 *      These funds are legally required to hold 80%+ equity; reporting <50% is
 *      a corrupt API response, not a real allocation shift.
 *   2. Pure debt funds (catRules.debt >= 80): reject if equity_pct > 20.
 *      Deliberately uses debt >= 80 rather than equity <= 10 to avoid rejecting
 *      overseas FoF funds, which also have equity=0 in catRules but legitimately
 *      return high equity_pct values from mfdata.in (ETFs in equity_holdings).
 */
export function isEquityPctPlausible(equityPct: number, catRules: CategoryComposition): boolean {
  if (catRules.equity >= 80 && equityPct < 50) return false;
  if (catRules.debt >= 80 && equityPct > 20) return false;
  return true;
}

/**
 * Returns true if the equity_holdings array is corrupted.
 *
 * Parallels `isDebtDataCorrupted`. mfdata.in occasionally returns benchmark
 * performance rows inside equity_holdings — recognisable by a numeric
 * `stock_name` (e.g. "-14.30"), a non-ISIN `isin` value, or a `weight_pct`
 * outside [0, 100]. Discard the entire array when this pattern is detected
 * rather than letting one bad row pollute both sector_allocation and the
 * market-cap classifier.
 */
export function isEquityHoldingsCorrupted(holdings: EquityHolding[]): boolean {
  if (holdings.length === 0) return false;
  let suspicious = 0;
  for (const h of holdings) {
    if (isNumericString(h.stock_name)) suspicious += 1;
    if (typeof h.weight_pct === 'number' && (h.weight_pct < 0 || h.weight_pct > 100)) suspicious += 1;
  }
  // A single bad row is enough to taint the array — sector aggregation sums every row.
  return suspicious > 0;
}

/**
 * Derives a canonical SEBI category key from a scheme's display name.
 *
 * AMFI sometimes returns the generic single-word category `"Equity"` (or
 * `"Hybrid"` / `"Debt"`) for funds that actually belong to a specific
 * SEBI sub-bucket — DSP Mid Cap Fund, for instance, is filed as
 * `scheme_category = 'Equity'`. The composition pipeline previously
 * mapped that to a flexi-cap proxy (`38/33/29`) and every such fund
 * displayed identical cap mixes on the Compare tab regardless of how it
 * actually invests.
 *
 * This helper rescues the sub-bucket from the scheme_name. The returned
 * key matches the lowercase keys used in the `CATEGORY_RULES` tables in
 * `sync-fund-portfolios/` and `fetch-fund-snapshot/`. Pattern order
 * matters: longer / more specific patterns (e.g. `"large & mid cap"`)
 * are checked before their substrings (`"large cap"`, `"mid cap"`) so a
 * "Large & Mid Cap Fund" doesn't get classified as a large-cap fund.
 *
 * Returns `null` when nothing matches — callers should fall through to
 * their existing category-based lookup or the final fallback.
 */
export function deriveSchemeCategoryFromName(
  schemeName: string | null | undefined,
): string | null {
  if (!schemeName) return null;
  const name = schemeName.toLowerCase();

  // Order matters — check longer/more-specific patterns first.
  // Each entry: [substrings to match (any), canonical CATEGORY_RULES key].
  const PATTERNS: Array<[string[], string]> = [
    // Equity sub-buckets — most specific first.
    // 'large & midcap' catches "Kotak Large & Midcap Fund" style names (one-word midcap).
    // 'large midcap' catches "Edelweiss NIFTY Large Midcap 250" style names (space, no &).
    // Both must appear before the bare 'midcap' entry below so they win over it.
    [['large & mid cap', 'large and mid cap', 'largemidcap', 'large-mid cap', 'large & midcap', 'large midcap'], 'large & mid cap fund'],
    [['multi cap', 'multi-cap', 'multicap'], 'multi cap fund'],
    [['flexi cap', 'flexicap'], 'flexi cap fund'],
    [['mid cap', 'midcap'], 'mid cap fund'],
    [['small cap', 'smallcap'], 'small cap fund'],
    [['large cap', 'largecap', 'bluechip', 'top 100', 'top 200'], 'large cap fund'],
    [['focused'], 'focused fund'],
    [['contra'], 'contra fund'],
    [['dividend yield'], 'dividend yield fund'],
    [['value'], 'value fund'],
    // 'tax savings' added so "Tax Savings Fund" names catch ELSS before 'savings fund' below.
    [['elss', 'tax saver', 'tax plan', 'tax savings', 'long term equity', 'long-term equity'], 'elss'],
    // 'banking and psu' must come BEFORE the sectoral/thematic 'psu' needle so that
    // "Banking and PSU Debt Fund" names resolve to banking-and-psu rather than thematic.
    [['banking and psu', 'banking & psu'], 'banking and psu fund'],
    [['sectoral', 'thematic', 'banking and financial', 'banking & financial',
      'pharma', 'healthcare', 'technology', 'infrastructure', 'consumption',
      'energy', 'manufacturing', 'business cycle', 'transport', 'logistics',
      'commodities', 'natural resources', 'india opportunities',
      // Additional high-confidence thematic patterns (null-category backfill).
      'momentum', 'innovation', 'esg', 'ethical', 'sustainability',
      'financial services', 'special opportunities', 'psu'], 'sectoral/thematic'],

    // Hybrid sub-buckets — order matters because "balanced" vs "balanced advantage".
    [['balanced advantage', 'dynamic asset allocation'], 'balanced advantage fund'],
    [['aggressive hybrid', 'equity hybrid', 'hybrid equity'], 'aggressive hybrid fund'],
    [['conservative hybrid'], 'conservative hybrid fund'],
    [['equity savings'], 'equity savings fund'],
    [['multi asset'], 'multi asset allocation'],
    // 'balanced hyrbrid' catches the typo seen in 360 ONE Balanced Hyrbrid Fund.
    [['balanced hybrid', 'balanced hyrbrid'], 'balanced hybrid fund'],
    [['arbitrage'], 'arbitrage fund'],

    // Passive / FoF. ETF is checked before 'gold fund' so "Gold ETF" stays in 'other etfs'.
    [['fund of fund', 'fund of funds', 'fof'], 'fund of funds domestic'],
    [['etf', ' bees'], 'other etfs'],
    // Gold Funds (without "etf" in the name) are FoFs investing in a domestic gold ETF.
    [['gold fund'], 'fund of funds domestic'],
    [['index fund', 'nifty', 'sensex', ' bse '], 'index funds'],

    // Debt sub-buckets.
    [['overnight'], 'overnight fund'],
    [['liquid'], 'liquid fund'],
    [['ultra short'], 'ultra short duration fund'],
    [['low duration'], 'low duration fund'],
    [['money market', 'money manager'], 'money market fund'],
    [['short duration', 'short term'], 'short duration fund'],
    [['medium to long duration'], 'medium to long duration'],
    // 'medium term' covers "Medium Term Plan" fund names used by some AMCs for
    // what SEBI now calls medium duration funds (Macaulay duration 3–4 years).
    [['medium duration', 'medium term'], 'medium duration fund'],
    // 'long term bond' covers ICICI Prudential / Franklin "Long Term Bond Fund"
    // which SEBI classifies as Long Duration (Macaulay duration > 7 years).
    [['long duration', 'long term bond'], 'long duration fund'],
    [['strategic bond', 'dynamic bond'], 'dynamic bond fund'],
    [['corporate bond'], 'corporate bond fund'],
    [['credit risk'], 'credit risk fund'],
    // 'government securities' / 'government bond' are the common fund-name form of gilt funds.
    // 'govenment' is a known AMFI typo in legacy scheme names.
    [['gilt', 'government securities', 'government bond', 'govt securities', 'govenment securities'], 'gilt fund'],
    [['floater', 'floating rate'], 'floater fund'],

    // Solution-oriented.
    [['retirement'], 'solution oriented - retirement'],
    // 'bal bhavishya' is the Hindi name for ABSL's children's fund.
    [["children's", 'childrens', 'children', 'bal bhavishya'], 'solution oriented - childrens'],
  ];

  for (const [needles, key] of PATTERNS) {
    if (needles.some((n) => name.includes(n))) return key;
  }
  return null;
}

/**
 * Non-canonical SEBI key spellings seen in mfdata.in responses and older AMFI
 * seed data. Each maps the raw (already lower-cased + trimmed) string to the
 * canonical key used by CATEGORY_RULES. Used by `resolveSebiCategory` so that
 * a non-generic but mis-spelled scheme_category still resolves correctly.
 *
 * Example: mfdata.in returns `"Large & Mid-Cap"` (hyphen, no "fund" suffix)
 * for some Aditya Birla / ICICI schemes; the canonical key is
 * `"large & mid cap fund"`.
 */
export const SEBI_CATEGORY_ALIASES: Record<string, string> = {
  'large & mid-cap': 'large & mid cap fund',  // hyphenated, no "fund" suffix
  'large & mid cap': 'large & mid cap fund',   // missing "fund" suffix
};

/**
 * Generic categories that AMFI / mfdata.in occasionally return as the bare
 * single-word value (`"Equity"`, `"Hybrid"`, `"Debt"`, `"Other"`). These are
 * useless for choosing a category-rules row — every equity scheme would hit
 * the same flexi-cap proxy. When the persisted scheme_category is one of
 * these, the resolver should prefer a sub-bucket derived from scheme_name.
 */
export function isGenericSchemeCategory(
  schemeCategory: string | null | undefined,
): boolean {
  if (!schemeCategory) return true;
  const key = schemeCategory.toLowerCase().trim();
  return key === 'equity' || key === 'debt' || key === 'hybrid' || key === 'other' || key === '';
}

/** The four broad asset classes used by the `scheme_master.scheme_category` column. */
export type BroadCategory = 'Equity' | 'Debt' | 'Hybrid' | 'Other';

/**
 * Maps a canonical SEBI sub-bucket key (the lowercase form used by
 * `CATEGORY_RULES` and returned by `deriveSchemeCategoryFromName` /
 * `resolveSebiCategory`) to its broad asset class.
 *
 * Solution-oriented schemes (retirement / children's) hold a mix of equity and
 * debt; they're grouped under `Hybrid` for asset-mix purposes. Overseas FoFs
 * map to `Other` (the underlying is foreign securities we don't classify),
 * domestic FoFs to `Hybrid` (the proxy split is genuinely mixed).
 *
 * Returns `null` for an unrecognised key — callers should leave the broad
 * column untouched rather than guess.
 */
export function broadCategoryFromSebi(
  sebiKey: string | null | undefined,
): BroadCategory | null {
  if (!sebiKey) return null;
  const key = sebiKey.toLowerCase().trim();

  const EQUITY = new Set([
    'large cap fund', 'mid cap fund', 'small cap fund', 'multi cap fund',
    'flexi cap fund', 'large & mid cap fund', 'elss', 'value fund',
    'contra fund', 'focused fund', 'sectoral/thematic', 'dividend yield fund',
    'index funds', 'other etfs',
  ]);
  const HYBRID = new Set([
    'aggressive hybrid fund', 'balanced hybrid fund', 'conservative hybrid fund',
    'balanced advantage fund', 'dynamic asset allocation', 'multi asset allocation',
    'equity savings fund', 'arbitrage fund', 'fund of funds domestic',
    'solution oriented - retirement', 'solution oriented - childrens',
  ]);
  const DEBT = new Set([
    'overnight fund', 'liquid fund', 'ultra short duration fund', 'low duration fund',
    'money market fund', 'short duration fund', 'medium duration fund',
    'medium to long duration', 'long duration fund', 'dynamic bond fund',
    'corporate bond fund', 'credit risk fund', 'banking and psu fund', 'gilt fund',
    'floater fund',
  ]);

  if (EQUITY.has(key)) return 'Equity';
  if (HYBRID.has(key)) return 'Hybrid';
  if (DEBT.has(key)) return 'Debt';
  if (key === 'fund of funds investing overseas') return 'Other';
  return null;
}

/**
 * Resolves the authoritative SEBI sub-bucket for a scheme, persisted to
 * `scheme_master.sebi_category`. This is the canonical granular value the
 * Compare screen and `getCategoryRules` lookups depend on.
 *
 * The supplied `schemeCategory` (from mfdata.in or the AMFI seed) is preferred
 * when it's already specific — but mfdata files many funds under the bare word
 * `"Equity"` (DSP Mid Cap, half the ICICI lineup, …), which is the exact root
 * cause of the "38/33/29" Compare bug (PR #188). When the category is generic /
 * blank, we fall back to deriving the bucket from the scheme name.
 *
 * Returns the lowercase canonical key (e.g. `"mid cap fund"`), or `null` when
 * neither source disambiguates — callers should leave `sebi_category` null and
 * let the read-time name parser keep covering that fund until a better signal
 * arrives.
 */
export function resolveSebiCategory(
  schemeCategory: string | null | undefined,
  schemeName: string | null | undefined,
): string | null {
  if (!isGenericSchemeCategory(schemeCategory)) {
    const raw = (schemeCategory as string).toLowerCase().trim();
    return SEBI_CATEGORY_ALIASES[raw] ?? raw;
  }
  return deriveSchemeCategoryFromName(schemeName);
}

// ── Sibling-category inheritance helpers ──────────────────────────────────

/**
 * Strips AMFI plan/option suffixes from a scheme name so that all plan
 * variants of the same fund (Direct/Regular, Growth/IDCW) share a common
 * "base name" string.  Used by `selectCategoryFromSiblings` to identify
 * same-family schemes within an AMC.
 *
 * Handles the real AMFI naming patterns seen in the wild:
 *   "Fund Name - Direct Plan - Growth"
 *   "Fund Name - Regular Plan Daily IDCW"
 *   "Fund Name - DIRECT - IDCW"  (no "Plan" word)
 *   "Fund Name - Growth"          (bare option suffix)
 *   "Fund Name - Growth - Direct Plan"  (option before plan type)
 */
export function normaliseSchemeName(name: string): string {
  return name
    .trim()
    // 1. Strip "- {plan_type} [Plan] [sep] {option}…" from the end.
    //    The option keyword is optional — handles bare "- Direct Plan" endings.
    //    'sep' = optional dash or space between "Plan" and the option word.
    .replace(
      /\s*-+\s*(?:direct|regular|dir)(?:\s+plan)?\s*(?:[-–]\s*|\s+)?(?:growth|idcw|income distribution|dividend|payout|reinvest|daily|weekly|monthly|quarterly|half\s*yearly|annual|standard|periodic|plan).*$/i,
      '',
    )
    // 2. Strip bare "- {option}…" suffix (no preceding plan-type keyword).
    .replace(
      /\s*-+\s*(?:growth|idcw|income distribution|dividend|payout|reinvest|daily|weekly|monthly|quarterly|half\s*yearly|annual|standard|periodic).*$/i,
      '',
    )
    // 3. Strip trailing bare plan type "- Direct [Plan]" / "- Regular [Plan]"
    //    that remains after earlier passes (e.g. "Fund - Growth - Direct Plan").
    .replace(/\s*-+\s*(?:direct|regular|dir)(?:\s+plan)?\s*$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Scheme row shape expected by selectCategoryFromSiblings.
 * Carries only the fields needed for sibling-category lookup.
 */
export interface SiblingCandidateRow {
  scheme_code: number;
  scheme_name: string;
  amc_name: string | null;
  scheme_category: string | null;
  sebi_category: string | null;
}

/**
 * Given a null-category target scheme and a pool of candidate rows from the
 * same DB (all scheme_active = true), returns the {sebi_category,
 * scheme_category} pair to inherit if:
 *
 *   • At least one candidate shares the same AMC and the same normalised base
 *     name as the target (i.e. the same fund family, different plan/option).
 *   • All matching candidates agree on the SAME {sebi_category, scheme_category}
 *     pair (unambiguous family).
 *
 * Returns null when:
 *   • The target already has sebi_category OR scheme_category (never overwrites).
 *   • No candidate matches (no categorised sibling found).
 *   • Candidates disagree on categories (ambiguous; skip rather than guess).
 *
 * Assumption: categories are family-level facts — all plan/option variants of
 * the same fund belong to the same SEBI sub-bucket and broad asset class.
 */
export function selectCategoryFromSiblings(
  target: SiblingCandidateRow,
  candidates: SiblingCandidateRow[],
): { sebi_category: string; scheme_category: string } | null {
  // Safety guard: never overwrite an existing category.
  if (target.sebi_category != null || target.scheme_category != null) return null;

  const targetBase = normaliseSchemeName(target.scheme_name);
  const targetAmc = (target.amc_name ?? '').toLowerCase().trim();

  // Find candidates that are a different scheme, same AMC, have both categories,
  // and share the same normalised base name.
  const matches = candidates.filter(
    (c) =>
      c.scheme_code !== target.scheme_code &&
      (c.amc_name ?? '').toLowerCase().trim() === targetAmc &&
      c.sebi_category != null &&
      c.scheme_category != null &&
      normaliseSchemeName(c.scheme_name) === targetBase,
  );

  if (matches.length === 0) return null;

  // Collect distinct {sebi_category, scheme_category} pairs.
  const pairs = new Map<string, { sebi_category: string; scheme_category: string }>();
  for (const m of matches) {
    const key = `${m.sebi_category}|||${m.scheme_category}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        sebi_category: m.sebi_category as string,
        scheme_category: m.scheme_category as string,
      });
    }
  }

  // Ambiguous family — different siblings disagree on category; skip.
  if (pairs.size !== 1) return null;

  return [...pairs.values()][0];
}
