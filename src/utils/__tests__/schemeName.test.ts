import { fundComparisonCategory, shortSchemeName } from '../schemeName';

describe('shortSchemeName', () => {
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
