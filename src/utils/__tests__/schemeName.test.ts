import { categoriesInSameGroup, fundComparisonCategory, fundComparisonKey, planOptionLabel, shortSchemeName } from '../schemeName';

describe('shortSchemeName (fallback for inactive registry shells)', () => {
  it('trims direct plan + growth suffix', () => {
    expect(shortSchemeName('HDFC Top 100 Fund - Direct Plan - Growth')).toBe('HDFC Top 100 Fund');
    expect(shortSchemeName('Axis Bluechip Fund - Direct Plan - Growth Option')).toBe('Axis Bluechip Fund');
  });

  it('trims regular plan + growth suffix', () => {
    expect(shortSchemeName('HDFC Top 100 Fund - Regular Plan - Growth')).toBe('HDFC Top 100 Fund');
  });

  it('trims short "- Growth" suffix', () => {
    expect(shortSchemeName('Mirae Asset Large Cap - Growth')).toBe('Mirae Asset Large Cap');
  });

  it('trims IDCW suffix', () => {
    expect(shortSchemeName('Parag Parikh Flexi Cap Fund - Direct Plan - IDCW')).toBe('Parag Parikh Flexi Cap Fund');
    expect(shortSchemeName('SBI Liquid Fund - IDCW Reinvest')).toBe('SBI Liquid Fund');
  });

  it('preserves the name when no recognisable suffix', () => {
    expect(shortSchemeName('Some Custom Fund')).toBe('Some Custom Fund');
  });

  it('case-insensitive on the suffix tokens', () => {
    expect(shortSchemeName('HDFC Top 100 Fund - direct plan - growth')).toBe('HDFC Top 100 Fund');
    expect(shortSchemeName('HDFC Top 100 Fund - DIRECT PLAN - GROWTH')).toBe('HDFC Top 100 Fund');
  });

  it('does not over-trim mid-name occurrences of "Growth"', () => {
    expect(shortSchemeName('Axis Growth Opportunities Fund - Direct Plan - Growth')).toBe('Axis Growth Opportunities Fund');
  });

  it('handles whitespace around the suffix', () => {
    expect(shortSchemeName('Quant Active Fund   -  Direct Plan - Growth   ')).toBe('Quant Active Fund');
  });

  it('passes through non-canonical AMFI names unchanged (known fallback limitation)', () => {
    // Hyphen-without-spaces suffix is not matched, so the full name is preserved.
    // This is an acceptable limitation for inactive shells; OF-indexed active
    // schemes use family_name directly.
    expect(shortSchemeName('BANK OF INDIA Small Cap Fund Direct Plan-Growth')).toBe(
      'BANK OF INDIA Small Cap Fund Direct Plan-Growth',
    );
  });
});

describe('planOptionLabel', () => {
  it('formats canonical plan + option pairs', () => {
    expect(planOptionLabel('direct', 'growth')).toBe('Direct · Growth');
    expect(planOptionLabel('regular', 'growth')).toBe('Regular · Growth');
    expect(planOptionLabel('direct', 'idcw_payout')).toBe('Direct · IDCW');
    expect(planOptionLabel('direct', 'idcw_reinvest')).toBe('Direct · IDCW Reinvest');
  });

  it('handles legacy/alias option keys', () => {
    expect(planOptionLabel('direct', 'idcw')).toBe('Direct · IDCW');
    expect(planOptionLabel('direct', 'dividend_payout')).toBe('Direct · IDCW');
    expect(planOptionLabel('direct', 'dividend_reinvest')).toBe('Direct · IDCW Reinvest');
  });

  it('returns plan-only when option_type is absent', () => {
    expect(planOptionLabel('direct', null)).toBe('Direct');
    expect(planOptionLabel('regular', undefined)).toBe('Regular');
  });

  it('returns option-only when plan_type is absent', () => {
    expect(planOptionLabel(null, 'growth')).toBe('Growth');
    expect(planOptionLabel(undefined, 'idcw_payout')).toBe('IDCW');
  });

  it('returns null when both fields are absent', () => {
    expect(planOptionLabel(null, null)).toBeNull();
    expect(planOptionLabel(undefined, undefined)).toBeNull();
  });

  it('passes through unknown values verbatim', () => {
    expect(planOptionLabel('direct', 'bonus')).toBe('Direct · Bonus');
    expect(planOptionLabel('direct', 'custom_option')).toBe('Direct · custom_option');
    // Unknown plan_type falls back to the raw string
    expect(planOptionLabel('institutional', 'growth')).toBe('institutional · Growth');
  });
});

describe('fundComparisonCategory', () => {
  it('maps each curated canonical sebi key to its label', () => {
    expect(fundComparisonCategory('large cap fund', 'Equity')).toBe('Large Cap');
    expect(fundComparisonCategory('mid cap fund', 'Equity')).toBe('Mid Cap');
    expect(fundComparisonCategory('small cap fund', 'Equity')).toBe('Small Cap');
    expect(fundComparisonCategory('flexi cap fund', 'Equity')).toBe('Flexi Cap');
    expect(fundComparisonCategory('multi cap fund', 'Equity')).toBe('Multi Cap');
    expect(fundComparisonCategory('large & mid cap fund', 'Equity')).toBe('Large & Mid Cap');
    expect(fundComparisonCategory('elss', 'Equity')).toBe('ELSS');
    expect(fundComparisonCategory('focused fund', 'Equity')).toBe('Focused');
    expect(fundComparisonCategory('value fund', 'Equity')).toBe('Value');
    expect(fundComparisonCategory('contra fund', 'Equity')).toBe('Contra');
    expect(fundComparisonCategory('dividend yield fund', 'Equity')).toBe('Dividend Yield');
    expect(fundComparisonCategory('sectoral/thematic', 'Equity')).toBe('Sectoral / Thematic');
  });

  it('title-cases canonical keys that are not in the curated label map', () => {
    expect(fundComparisonCategory('liquid fund', 'Debt')).toBe('Liquid Fund');
    expect(fundComparisonCategory('gilt fund', 'Debt')).toBe('Gilt Fund');
    expect(fundComparisonCategory('aggressive hybrid fund', 'Hybrid')).toBe('Aggressive Hybrid Fund');
  });

  it('is case-insensitive and trims the sebi key', () => {
    expect(fundComparisonCategory('  MID CAP FUND ', 'Equity')).toBe('Mid Cap');
  });

  it('does not parse the scheme name — only the authoritative sebi_category counts', () => {
    // A "Large Cap Fund" by name but persisted as mid cap reads as Mid Cap; the
    // app never re-derives category from the name (single source of truth).
    expect(fundComparisonCategory('mid cap fund', 'Equity')).toBe('Mid Cap');
  });

  it('falls back to the broad asset class when sebi_category is NULL', () => {
    expect(fundComparisonCategory(null, 'Equity')).toBe('Equity');
    expect(fundComparisonCategory(null, 'Debt')).toBe('Debt');
    expect(fundComparisonCategory(undefined, 'Hybrid')).toBe('Hybrid');
  });

  it('falls back to "Other" when neither sebi_category nor broad class is set', () => {
    expect(fundComparisonCategory(null, null)).toBe('Other');
    expect(fundComparisonCategory('   ', null)).toBe('Other');
  });

  it('treats two funds with the same sebi_category as comparable', () => {
    expect(fundComparisonCategory('large cap fund', 'Equity')).toBe(
      fundComparisonCategory('large cap fund', 'Equity'),
    );
  });
});

// ---------------------------------------------------------------------------
// fundComparisonKey
// ---------------------------------------------------------------------------

describe('fundComparisonKey', () => {
  it('returns the canonical lowercase sebi key when sebiCategory is set', () => {
    expect(fundComparisonKey('large & mid cap fund', 'Equity')).toBe('large & mid cap fund');
    expect(fundComparisonKey('mid cap fund', 'Equity')).toBe('mid cap fund');
    expect(fundComparisonKey('Large Cap Fund', null)).toBe('large cap fund');
  });

  it('normalises "large & mid-cap" (hyphenated, legacy) to the canonical key', () => {
    expect(fundComparisonKey('large & mid-cap', 'Large & Mid Cap Fund')).toBe('large & mid cap fund');
    expect(fundComparisonKey('Large & Mid-Cap', null)).toBe('large & mid cap fund');
  });

  it('normalises "large & mid cap" (missing "fund" suffix) to the canonical key', () => {
    expect(fundComparisonKey('large & mid cap', null)).toBe('large & mid cap fund');
  });

  it('falls back to broad category (lowercase) when sebiCategory is null', () => {
    expect(fundComparisonKey(null, 'Equity')).toBe('equity');
    expect(fundComparisonKey(null, 'Debt')).toBe('debt');
    expect(fundComparisonKey(undefined, 'Hybrid')).toBe('hybrid');
  });

  it('returns "other" when both are absent', () => {
    expect(fundComparisonKey(null, null)).toBe('other');
    expect(fundComparisonKey(undefined, undefined)).toBe('other');
  });

  it('returns "other" when sebiCategory is whitespace-only', () => {
    expect(fundComparisonKey('   ', null)).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// categoriesInSameGroup  — §3 rows (the 3 dirty-data scenarios)
// ---------------------------------------------------------------------------

describe('categoriesInSameGroup', () => {
  // §3 row 1: non-canonical alias normalised before comparison
  it('same canonical key after normalisation → same group (banner should NOT fire)', () => {
    // Callers pass the output of fundComparisonKey; these are already normalised.
    expect(categoriesInSameGroup('large & mid cap fund', 'large & mid cap fund')).toBe(true);
  });

  // §3 row 2: broad 'equity' fallback vs a specific sub-bucket
  it('broad equity fallback vs specific equity sub-bucket → same group (not yet backfilled)', () => {
    expect(categoriesInSameGroup('equity', 'large & mid cap fund')).toBe(true);
    expect(categoriesInSameGroup('large & mid cap fund', 'equity')).toBe(true);
    expect(categoriesInSameGroup('equity', 'mid cap fund')).toBe(true);
    expect(categoriesInSameGroup('equity', 'large cap fund')).toBe(true);
    expect(categoriesInSameGroup('equity', 'index funds')).toBe(true);
  });

  // §3 row 3: genuinely different categories must still fire the banner
  it('mid cap vs large & mid cap → different groups (banner SHOULD fire)', () => {
    expect(categoriesInSameGroup('mid cap fund', 'large & mid cap fund')).toBe(false);
  });

  it('large cap vs mid cap → different groups', () => {
    expect(categoriesInSameGroup('large cap fund', 'mid cap fund')).toBe(false);
  });

  it('equity vs debt → different groups', () => {
    expect(categoriesInSameGroup('equity', 'liquid fund')).toBe(false);
    expect(categoriesInSameGroup('equity', 'debt')).toBe(false);
  });

  it('hybrid vs equity → different groups', () => {
    expect(categoriesInSameGroup('hybrid', 'large cap fund')).toBe(false);
  });

  it('broad debt vs broad equity → different groups', () => {
    expect(categoriesInSameGroup('debt', 'equity')).toBe(false);
  });
});
