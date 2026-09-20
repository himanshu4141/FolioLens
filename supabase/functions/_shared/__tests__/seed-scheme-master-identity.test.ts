import { detectPlanType, inferAmcName } from '../seed-scheme-master-identity';

describe('detectPlanType', () => {
  it('detects direct plan with the classic " - Direct Growth" shape', () => {
    expect(detectPlanType('Axis Bluechip Fund - Direct Growth')).toBe('direct');
  });

  it('detects regular plan with the classic " - Regular Growth" shape', () => {
    expect(detectPlanType('Axis Bluechip Fund - Regular Growth')).toBe('regular');
  });

  it('detects "Direct Plan" with the dash separator (AMFI-composed shape)', () => {
    expect(detectPlanType('Axis Bluechip Fund - Direct Plan - Growth')).toBe('direct');
  });

  it('detects "Regular Plan" with the dash separator', () => {
    expect(detectPlanType('Axis Bluechip Fund - Regular Plan - IDCW')).toBe('regular');
  });

  // M2.2: tolerate "Direct Plan" / "Regular Plan" without the ' - ' dash
  // separator. \b (word boundary) matching treats a plain space and a dash
  // identically, so this already works without a regex change — these tests
  // pin that behaviour so a future refactor doesn't regress it.
  it('tolerates "Direct Plan" without a dash separator (space-only)', () => {
    expect(detectPlanType('Axis Bluechip Fund Direct Plan Growth')).toBe('direct');
  });

  it('tolerates "Regular Plan" without a dash separator (space-only)', () => {
    expect(detectPlanType('Axis Bluechip Fund Regular Plan Growth')).toBe('regular');
  });

  it('detects direct via a Direct-Growth dash with no surrounding spaces', () => {
    expect(detectPlanType('Axis Bluechip Fund-Direct-Growth')).toBe('direct');
  });

  it('is case-insensitive', () => {
    expect(detectPlanType('AXIS BLUECHIP FUND - DIRECT PLAN - GROWTH')).toBe('direct');
  });

  it('returns null for a family-only name with no plan signal at all', () => {
    expect(detectPlanType('Axis Bluechip Fund')).toBeNull();
  });

  it('returns null when neither direct nor regular keywords appear', () => {
    expect(detectPlanType('Axis Bluechip Fund - IDCW')).toBeNull();
  });
});

describe('inferAmcName', () => {
  it('extracts the AMC name before "Mutual Fund"', () => {
    expect(inferAmcName('HDFC Mutual Fund - Balanced Advantage Fund - Direct Growth')).toBe('HDFC');
  });

  it('extracts the AMC name before a bare "Fund" suffix', () => {
    expect(inferAmcName('Axis Fund - Bluechip - Direct Growth')).toBe('Axis');
  });

  it('falls back to the first three words when no AMC-suffix keyword matches', () => {
    expect(inferAmcName('Some Random Scheme Name Without Keywords')).toBe('Some Random Scheme');
  });

  it('returns null for an empty name', () => {
    expect(inferAmcName('')).toBeNull();
  });
});
