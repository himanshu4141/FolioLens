import {
  parseMfapiSchemeIdentity,
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
});
