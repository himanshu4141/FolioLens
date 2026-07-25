import { planOpenFolioNavDeltaRouting } from '../nav-delta-routing';
import type { NavDeltaResponse } from '../openfolio';

function delta(overrides: Partial<NavDeltaResponse> = {}): NavDeltaResponse {
  return {
    requested: 0,
    matched: 0,
    items: [],
    latest: [],
    missing_scheme_codes: [],
    truncated_scheme_codes: [],
    ...overrides,
  };
}

describe('planOpenFolioNavDeltaRouting', () => {
  it('uses matched delta rows and routes missing schemes to fallback', () => {
    const result = planOpenFolioNavDeltaRouting(
      [101, 202, 303],
      delta({
        requested: 3,
        matched: 2,
        items: [
          { scheme_code: 101, date: '2026-07-20', nav: 10.1 },
          { scheme_code: 202, date: '2026-07-20', nav: 20.2 },
        ],
        latest: [
          { scheme_code: 101, date: '2026-07-20' },
          { scheme_code: 202, date: '2026-07-20' },
        ],
        missing_scheme_codes: [303],
      }),
    );

    expect(result.usableItems.map((item) => item.scheme_code)).toEqual([101, 202]);
    expect(result.openfolioSchemeCodes).toEqual([101, 202]);
    expect(result.fallbackSchemeCodes).toEqual([303]);
    expect(result.omittedSchemeCodes).toEqual([]);
  });

  it('does not bulk-upsert partial rows for truncated schemes', () => {
    const result = planOpenFolioNavDeltaRouting(
      [101, 202],
      delta({
        requested: 2,
        matched: 2,
        items: [
          { scheme_code: 101, date: '2026-07-20', nav: 10.1 },
          { scheme_code: 202, date: '2020-01-01', nav: 5.1 },
        ],
        latest: [
          { scheme_code: 101, date: '2026-07-20' },
          { scheme_code: 202, date: '2026-07-20' },
        ],
        truncated_scheme_codes: [202],
      }),
    );

    expect(result.usableItems).toEqual([{ scheme_code: 101, date: '2026-07-20', nav: 10.1 }]);
    expect(result.openfolioSchemeCodes).toEqual([101]);
    expect(result.fallbackSchemeCodes).toEqual([202]);
    expect(result.omittedSchemeCodes).toEqual([]);
  });

  it('routes a requested scheme omitted from the delta response to fallback', () => {
    const result = planOpenFolioNavDeltaRouting(
      [101, 202],
      delta({
        requested: 2,
        matched: 1,
        items: [{ scheme_code: 101, date: '2026-07-20', nav: 10.1 }],
        latest: [{ scheme_code: 101, date: '2026-07-20' }],
      }),
    );

    expect(result.usableItems.map((item) => item.scheme_code)).toEqual([101]);
    expect(result.openfolioSchemeCodes).toEqual([101]);
    expect(result.fallbackSchemeCodes).toEqual([202]);
    expect(result.omittedSchemeCodes).toEqual([202]);
  });
});
