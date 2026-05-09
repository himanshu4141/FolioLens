import { shortSchemeName } from '../schemeName';

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
