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
  it('parses the SEBI equity sub-category from the scheme name', () => {
    expect(fundComparisonCategory('Mirae Asset Large Cap Fund', 'Equity')).toBe('Large Cap');
    expect(fundComparisonCategory('HDFC Mid-Cap Opportunities Fund', 'Equity')).toBe('Mid Cap');
    expect(fundComparisonCategory('SBI Small Cap Fund', 'Equity')).toBe('Small Cap');
    expect(fundComparisonCategory('Parag Parikh Flexi Cap Fund', 'Equity')).toBe('Flexi Cap');
    expect(fundComparisonCategory('Kotak Multicap Fund', 'Equity')).toBe('Multi Cap');
  });

  it('prefers "Large & Mid Cap" over the narrower cap rules', () => {
    expect(fundComparisonCategory('Canara Robeco Large & Mid Cap Fund', 'Equity')).toBe('Large & Mid Cap');
    expect(fundComparisonCategory('SBI Large and Mid Cap Fund', 'Equity')).toBe('Large & Mid Cap');
  });

  it('maps common large-cap synonyms', () => {
    expect(fundComparisonCategory('Axis Bluechip Fund', 'Equity')).toBe('Large Cap');
    expect(fundComparisonCategory('HDFC Top 100 Fund', 'Equity')).toBe('Large Cap');
  });

  it('parses style/thematic equity categories', () => {
    expect(fundComparisonCategory('Axis ELSS Tax Saver Fund', 'Equity')).toBe('ELSS');
    expect(fundComparisonCategory('SBI Focused Equity Fund', 'Equity')).toBe('Focused');
    expect(fundComparisonCategory('ICICI Prudential Value Discovery Fund', 'Equity')).toBe('Value');
    expect(fundComparisonCategory('SBI Contra Fund', 'Equity')).toBe('Contra');
    expect(fundComparisonCategory('ICICI Prudential Technology Fund', 'Equity')).toBe('Sectoral / Thematic');
  });

  it('falls back to the broad category when no sub-category is in the name', () => {
    expect(fundComparisonCategory('HDFC Corporate Bond Fund', 'Debt')).toBe('Debt');
    expect(fundComparisonCategory('Some Custom Fund', null)).toBe('Other');
  });

  it('treats two funds in the same sub-category as comparable', () => {
    const a = fundComparisonCategory('Mirae Asset Large Cap Fund - Direct Plan - Growth', 'Equity');
    const b = fundComparisonCategory('Nippon India Large Cap Fund', 'Equity');
    expect(a).toBe(b);
  });

  describe('sebi_category preference', () => {
    it('prefers the persisted sebi_category over the parsed name', () => {
      // Name parser would say "Flexi Cap"; the authoritative sebi key wins.
      expect(
        fundComparisonCategory('Some Renamed Flexi Cap Fund', 'Equity', 'mid cap fund'),
      ).toBe('Mid Cap');
    });

    it('maps each known canonical key to its label', () => {
      expect(fundComparisonCategory('x', 'Equity', 'large & mid cap fund')).toBe('Large & Mid Cap');
      expect(fundComparisonCategory('x', 'Equity', 'elss')).toBe('ELSS');
      expect(fundComparisonCategory('x', 'Equity', 'sectoral/thematic')).toBe('Sectoral / Thematic');
    });

    it('is case-insensitive on the sebi key', () => {
      expect(fundComparisonCategory('x', 'Equity', 'MID CAP FUND')).toBe('Mid Cap');
    });

    it('falls back to the name parser when sebi_category is null or unmapped', () => {
      expect(fundComparisonCategory('SBI Small Cap Fund', 'Equity', null)).toBe('Small Cap');
      // A debt sub-bucket isn't in the equity-label map → fall through to the
      // name/broad logic, which returns the broad class for non-equity.
      expect(fundComparisonCategory('HDFC Liquid Fund', 'Debt', 'liquid fund')).toBe('Debt');
    });
  });
});
