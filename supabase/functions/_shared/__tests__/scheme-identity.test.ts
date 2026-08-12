import {
  benchmarkForCategory,
  categoryNameForHydration,
  parseMfapiSchemeIdentity,
  pendingIdentityIsDue,
  uniqueSchemeCodes,
} from '../scheme-identity';

describe('CAS provisional scheme identity hydration', () => {
  it('includes pending provisional identities even when no active holding references them', () => {
    expect(uniqueSchemeCodes([101, 202], [202, 303])).toEqual([101, 202, 303]);
  });

  it('accepts only a non-empty canonical mfapi scheme name', () => {
    expect(parseMfapiSchemeIdentity({
      meta: { scheme_name: '  Canonical Fund - Direct Growth  ', isin_growth: ' INF000000001 ' },
    })).toEqual({
      schemeName: 'Canonical Fund - Direct Growth',
      isin: 'INF000000001',
    });
    expect(parseMfapiSchemeIdentity({ meta: { scheme_name: '   ' } })).toBeNull();
    expect(parseMfapiSchemeIdentity({ data: {} })).toBeNull();
  });

  it('allows canonical identity without an ISIN', () => {
    expect(parseMfapiSchemeIdentity({ meta: { scheme_name: 'Canonical Fund' } })).toEqual({
      schemeName: 'Canonical Fund',
      isin: null,
    });
  });

  it('backs off a failed pending identity until the retry interval elapses', () => {
    const now = Date.parse('2026-08-12T00:00:00Z');
    expect(pendingIdentityIsDue(null, now)).toBe(true);
    expect(pendingIdentityIsDue('2026-08-11T23:59:00Z', now)).toBe(false);
    expect(pendingIdentityIsDue('2026-08-10T23:59:00Z', now)).toBe(true);
  });

  it('never derives a pending category from the provisional CAS name', () => {
    expect(categoryNameForHydration(true, null, 'Untrusted Index Fund')).toBeNull();
    expect(categoryNameForHydration(true, 'Canonical Small Cap Fund', 'Untrusted Index Fund'))
      .toBe('Canonical Small Cap Fund');
    expect(categoryNameForHydration(false, null, 'Existing Small Cap Fund'))
      .toBe('Existing Small Cap Fund');
  });

  it('resolves a benchmark pair from the hydrated granular category', () => {
    const mappings = new Map([['small cap fund', {
      benchmarkIndex: 'Nifty Smallcap 250 TRI',
      benchmarkIndexSymbol: '^NIFTYSMALLCAP250',
    }]]);
    expect(benchmarkForCategory('Small Cap Fund', mappings)).toEqual({
      benchmarkIndex: 'Nifty Smallcap 250 TRI',
      benchmarkIndexSymbol: '^NIFTYSMALLCAP250',
    });
    expect(benchmarkForCategory(null, mappings)).toBeNull();
  });
});
