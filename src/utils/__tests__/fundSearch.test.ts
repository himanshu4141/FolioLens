/**
 * Tests for the fund search query builder and family-first picker helpers.
 * We mock at the data-wrapper boundary (`@/src/lib/data/schemeMaster` and
 * `@/src/lib/data/schemeFamilySearch`), never the supabase module, per the
 * repo convention. The chainable query builder is a hand-rolled spy so we can
 * assert the exact filter calls each function issues per token.
 */
import {
  searchSchemes,
  searchFamilies,
  resolveFamilyToScheme,
  fetchFamilyPlans,
  fetchUserHeldSchemes,
  fetchUserHeldFamilies,
  tokenizeQuery,
  type SchemeSearchResult,
  type FamilySearchResult,
  type FamilyPlan,
  type PlanPreference,
} from '../fundSearch';

// --- chainable query-builder mock ------------------------------------------

interface QB {
  select: jest.Mock;
  order: jest.Mock;
  range: jest.Mock;
  or: jest.Mock;
  eq: jest.Mock;
  not: jest.Mock;
  in: jest.Mock;
  then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => Promise<unknown>;
}

let lastSchemeMasterBuilder: QB;
let lastFamilySearchBuilder: QB;
let lastUserFundBuilder: QB;
let returnedRows: Record<string, unknown>[] = [];
let returnedFamilyRows: Record<string, unknown>[] = [];
let returnedUserFundRows: Record<string, unknown>[] = [];

function makeBuilder(getRows: () => Record<string, unknown>[]): QB {
  const qb = {} as QB;
  const chain = () => qb;
  qb.select = jest.fn(chain);
  qb.order = jest.fn(chain);
  qb.range = jest.fn(chain);
  qb.or = jest.fn(chain);
  qb.eq = jest.fn(chain);
  qb.not = jest.fn(chain);
  qb.in = jest.fn(chain);
  qb.then = (resolve) => Promise.resolve(resolve({ data: getRows(), error: null }));
  return qb;
}

jest.mock('@/src/lib/data/schemeMaster', () => ({
  schemeMasterRepo: {
    from: () => {
      lastSchemeMasterBuilder = makeBuilder(() => returnedRows);
      return lastSchemeMasterBuilder;
    },
  },
}));

jest.mock('@/src/lib/data/schemeFamilySearch', () => ({
  schemeFamilySearchRepo: {
    from: () => {
      lastFamilySearchBuilder = makeBuilder(() => returnedFamilyRows);
      return lastFamilySearchBuilder;
    },
  },
}));

jest.mock('@/src/lib/data/userFund', () => ({
  userFundRepo: {
    from: () => {
      lastUserFundBuilder = makeBuilder(() => returnedUserFundRows);
      return lastUserFundBuilder;
    },
  },
}));

beforeEach(() => {
  returnedRows = [];
  returnedFamilyRows = [];
  returnedUserFundRows = [];
});

// ---------------------------------------------------------------------------
// tokenizeQuery
// ---------------------------------------------------------------------------

describe('tokenizeQuery', () => {
  it('splits on whitespace, lowercases, strips punctuation', () => {
    expect(tokenizeQuery('Large & Mid Cap Direct')).toEqual(['large', 'mid', 'cap', 'direct']);
  });

  it('drops fragments shorter than 2 chars (incl. bare "&")', () => {
    expect(tokenizeQuery('HDFC & a Midcap')).toEqual(['hdfc', 'midcap']);
  });

  it('collapses repeated/edge whitespace', () => {
    expect(tokenizeQuery('  axis   bluechip  ')).toEqual(['axis', 'bluechip']);
  });

  it('returns [] for empty / punctuation-only input', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('   ')).toEqual([]);
    expect(tokenizeQuery('& - .')).toEqual([]);
  });

  it('keeps alphanumerics inside a token (e.g. "top100")', () => {
    expect(tokenizeQuery('Top 100')).toEqual(['top', '100']);
  });
});

// ---------------------------------------------------------------------------
// searchSchemes — token AND across columns
// ---------------------------------------------------------------------------

describe('searchSchemes — token AND across columns', () => {
  it('issues one OR-group per token (so all tokens must match)', async () => {
    await searchSchemes({ query: 'large & mid cap direct' });
    // 4 real tokens (the "&" is dropped) → 4 .or() calls.
    expect(lastSchemeMasterBuilder.or).toHaveBeenCalledTimes(4);
    const groups = lastSchemeMasterBuilder.or.mock.calls.map((c) => c[0]);
    expect(groups[0]).toBe(
      'scheme_name.ilike.%large%,sebi_category.ilike.%large%,amc_name.ilike.%large%',
    );
    expect(groups).toContain(
      'scheme_name.ilike.%direct%,sebi_category.ilike.%direct%,amc_name.ilike.%direct%',
    );
  });

  it('does not call .or() when the query is empty (returns first page)', async () => {
    await searchSchemes({ query: '' });
    expect(lastSchemeMasterBuilder.or).not.toHaveBeenCalled();
  });

  it('applies amcName and category as eq filters', async () => {
    await searchSchemes({ query: 'cap', amcName: 'HDFC Mutual Fund', category: 'Equity' });
    expect(lastSchemeMasterBuilder.eq).toHaveBeenCalledWith('amc_name', 'HDFC Mutual Fund');
    expect(lastSchemeMasterBuilder.eq).toHaveBeenCalledWith('scheme_category', 'Equity');
  });

  it('maps rows including the new sebiCategory field and openfolioMetaSyncedAt', async () => {
    returnedRows = [
      {
        scheme_code: 119071,
        scheme_name: 'DSP Mid Cap Fund - Direct Plan - Growth',
        scheme_category: 'Equity',
        sebi_category: 'mid cap fund',
        amc_name: 'DSP Mutual Fund',
        plan_type: 'direct',
        isin: 'INF000000001',
        scheme_active: true,
        openfolio_meta_synced_at: '2026-06-01T12:00:00Z',
      },
    ];
    const out: SchemeSearchResult[] = await searchSchemes({ query: 'dsp mid cap' });
    expect(out[0]).toEqual({
      schemeCode: 119071,
      schemeName: 'DSP Mid Cap Fund - Direct Plan - Growth',
      schemeCategory: 'Equity',
      sebiCategory: 'mid cap fund',
      amcName: 'DSP Mutual Fund',
      planType: 'direct',
      isin: 'INF000000001',
      schemeActive: true,
      openfolioMetaSyncedAt: '2026-06-01T12:00:00Z',
    });
  });

  it('orders by scheme_active DESC NULLS LAST, then openfolio_meta_synced_at DESC NULLS LAST, then scheme_name ASC', async () => {
    await searchSchemes({ query: 'cap' });
    expect(lastSchemeMasterBuilder.order).toHaveBeenCalledTimes(3);
    expect(lastSchemeMasterBuilder.order).toHaveBeenNthCalledWith(1, 'scheme_active', {
      ascending: false,
      nullsFirst: false,
    });
    expect(lastSchemeMasterBuilder.order).toHaveBeenNthCalledWith(2, 'openfolio_meta_synced_at', {
      ascending: false,
      nullsFirst: false,
    });
    expect(lastSchemeMasterBuilder.order).toHaveBeenNthCalledWith(3, 'scheme_name', {
      ascending: true,
    });
  });

  it('handles schemeActive null correctly (schemes pending first sync)', async () => {
    returnedRows = [
      {
        scheme_code: 100001,
        scheme_name: 'Active Fund',
        scheme_category: 'Equity',
        sebi_category: 'large cap fund',
        amc_name: 'Fund AMC',
        plan_type: 'direct',
        isin: 'INF000000001',
        scheme_active: true,
        openfolio_meta_synced_at: '2026-06-01T12:00:00Z',
      },
      {
        scheme_code: 100003,
        scheme_name: 'Inactive Fund',
        scheme_category: 'Equity',
        sebi_category: 'small cap fund',
        amc_name: 'Fund AMC',
        plan_type: 'direct',
        isin: 'INF000000003',
        scheme_active: false,
        openfolio_meta_synced_at: null,
      },
      {
        scheme_code: 100002,
        scheme_name: 'Unknown Fund',
        scheme_category: 'Equity',
        sebi_category: 'mid cap fund',
        amc_name: 'Fund AMC',
        plan_type: 'direct',
        isin: 'INF000000002',
        scheme_active: null,
        openfolio_meta_synced_at: null,
      },
    ];
    const out: SchemeSearchResult[] = await searchSchemes({ query: 'fund' });
    expect(out).toHaveLength(3);
    expect(out[0].schemeActive).toBe(true);
    expect(out[1].schemeActive).toBe(false);
    expect(out[2].schemeActive).toBe(null);
  });

  it('orders by openfolio_meta_synced_at DESC NULLS LAST within same scheme_active', async () => {
    returnedRows = [
      {
        scheme_code: 100002,
        scheme_name: 'Beta Fund',
        scheme_category: 'Equity',
        sebi_category: 'mid cap fund',
        amc_name: 'Fund AMC',
        plan_type: 'direct',
        isin: 'INF000000002',
        scheme_active: true,
        openfolio_meta_synced_at: '2026-06-05T12:00:00Z',
      },
      {
        scheme_code: 100001,
        scheme_name: 'Alpha Fund',
        scheme_category: 'Equity',
        sebi_category: 'large cap fund',
        amc_name: 'Fund AMC',
        plan_type: 'direct',
        isin: 'INF000000001',
        scheme_active: true,
        openfolio_meta_synced_at: '2026-06-01T12:00:00Z',
      },
      {
        scheme_code: 100003,
        scheme_name: 'Charlie Fund',
        scheme_category: 'Equity',
        sebi_category: 'small cap fund',
        amc_name: 'Fund AMC',
        plan_type: 'direct',
        isin: 'INF000000003',
        scheme_active: true,
        openfolio_meta_synced_at: null,
      },
    ];
    const out: SchemeSearchResult[] = await searchSchemes({ query: 'fund' });
    expect(out).toHaveLength(3);
    expect(out[0].schemeName).toBe('Beta Fund');
    expect(out[0].openfolioMetaSyncedAt).toBe('2026-06-05T12:00:00Z');
    expect(out[1].schemeName).toBe('Alpha Fund');
    expect(out[1].openfolioMetaSyncedAt).toBe('2026-06-01T12:00:00Z');
    expect(out[2].schemeName).toBe('Charlie Fund');
    expect(out[2].openfolioMetaSyncedAt).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// searchFamilies — family-level view queries
// ---------------------------------------------------------------------------

describe('searchFamilies — family-level view', () => {
  it('issues one OR-group per token across family_name / sebi_category / amc_name', async () => {
    await searchFamilies({ query: 'hdfc large mid' });
    expect(lastFamilySearchBuilder.or).toHaveBeenCalledTimes(3);
    const groups = lastFamilySearchBuilder.or.mock.calls.map((c: string[][]) => c[0]);
    expect(groups[0]).toBe(
      'family_name.ilike.%hdfc%,sebi_category.ilike.%hdfc%,amc_name.ilike.%hdfc%',
    );
    expect(groups[1]).toBe(
      'family_name.ilike.%large%,sebi_category.ilike.%large%,amc_name.ilike.%large%',
    );
  });

  it('issues no .or() calls for an empty query', async () => {
    await searchFamilies({ query: '' });
    expect(lastFamilySearchBuilder.or).not.toHaveBeenCalled();
  });

  it('orders by family_active DESC, max_synced_at DESC, family_name ASC', async () => {
    await searchFamilies({ query: 'cap' });
    expect(lastFamilySearchBuilder.order).toHaveBeenNthCalledWith(1, 'family_active', {
      ascending: false,
      nullsFirst: false,
    });
    expect(lastFamilySearchBuilder.order).toHaveBeenNthCalledWith(2, 'max_synced_at', {
      ascending: false,
      nullsFirst: false,
    });
    expect(lastFamilySearchBuilder.order).toHaveBeenNthCalledWith(3, 'family_name', {
      ascending: true,
      nullsFirst: false,
    });
  });

  it('maps family rows correctly', async () => {
    returnedFamilyRows = [
      {
        of_family_id: 'OF-abc123',
        family_name: 'HDFC Large & Mid Cap Fund',
        amc_name: 'HDFC Mutual Fund',
        sebi_category: 'large & mid cap fund',
        scheme_category: 'Equity',
        has_direct: true,
        has_regular: true,
        has_growth: true,
        has_idcw: false,
        representative_scheme_code: 119597,
        family_active: true,
      },
    ];
    const out: FamilySearchResult[] = await searchFamilies({ query: 'hdfc large' });
    expect(out[0]).toEqual({
      ofFamilyId: 'OF-abc123',
      familyName: 'HDFC Large & Mid Cap Fund',
      amcName: 'HDFC Mutual Fund',
      sebiCategory: 'large & mid cap fund',
      schemeCategory: 'Equity',
      hasDirect: true,
      hasRegular: true,
      hasGrowth: true,
      hasIdcw: false,
      representativeSchemeCode: 119597,
      familyActive: true,
    });
  });

  it('returns empty array when no families match', async () => {
    returnedFamilyRows = [];
    const out = await searchFamilies({ query: 'zzz_no_match' });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveFamilyToScheme — pure plan resolution function
// ---------------------------------------------------------------------------

describe('resolveFamilyToScheme', () => {
  const directGrowth: PlanPreference = { planType: 'direct', optionType: 'growth' };
  const regularGrowth: PlanPreference = { planType: 'regular', optionType: 'growth' };
  const directIdcw: PlanPreference = { planType: 'direct', optionType: 'idcw' };
  const regularIdcw: PlanPreference = { planType: 'regular', optionType: 'idcw' };

  const makePlan = (
    code: number,
    planType: FamilyPlan['planType'],
    optionType: FamilyPlan['optionType'],
  ): FamilyPlan => ({ schemeCode: code, planType, optionType });

  it('returns null for empty plans array', () => {
    expect(resolveFamilyToScheme([], directGrowth)).toBeNull();
  });

  it('returns exact match Direct · Growth (no fallback)', () => {
    const plans: FamilyPlan[] = [
      makePlan(1001, 'direct', 'growth'),
      makePlan(1002, 'regular', 'growth'),
    ];
    const result = resolveFamilyToScheme(plans, directGrowth);
    expect(result).toMatchObject({ schemeCode: 1001, isFallback: false, fallbackReason: null });
  });

  it('returns exact match Regular · Growth (no fallback)', () => {
    const plans: FamilyPlan[] = [
      makePlan(1001, 'direct', 'growth'),
      makePlan(1002, 'regular', 'growth'),
    ];
    const result = resolveFamilyToScheme(plans, regularGrowth);
    expect(result).toMatchObject({ schemeCode: 1002, isFallback: false, fallbackReason: null });
  });

  it('prefers idcw_payout over idcw_reinvest for IDCW preference', () => {
    const plans: FamilyPlan[] = [
      makePlan(2001, 'direct', 'idcw_reinvest'),
      makePlan(2002, 'direct', 'idcw_payout'),
    ];
    const result = resolveFamilyToScheme(plans, directIdcw);
    expect(result).toMatchObject({ schemeCode: 2002, isFallback: false });
  });

  it('falls back to Regular-only when Direct is unavailable (Regular-only family)', () => {
    const plans: FamilyPlan[] = [makePlan(3001, 'regular', 'growth')];
    const result = resolveFamilyToScheme(plans, directGrowth);
    expect(result).toMatchObject({
      schemeCode: 3001,
      isFallback: true,
      fallbackReason: 'Regular-only',
    });
  });

  it('falls back to Direct-only when Regular is unavailable (Direct-only family)', () => {
    const plans: FamilyPlan[] = [makePlan(4001, 'direct', 'growth')];
    const result = resolveFamilyToScheme(plans, regularGrowth);
    expect(result).toMatchObject({
      schemeCode: 4001,
      isFallback: true,
      fallbackReason: 'Direct-only',
    });
  });

  it('falls back to Growth-only when IDCW is unavailable (Growth-only family)', () => {
    const plans: FamilyPlan[] = [
      makePlan(5001, 'direct', 'growth'),
      makePlan(5002, 'regular', 'growth'),
    ];
    const result = resolveFamilyToScheme(plans, directIdcw);
    expect(result).toMatchObject({
      schemeCode: 5001,
      isFallback: true,
      fallbackReason: 'IDCW-only',
    });
  });

  it('falls back to IDCW-only when Growth is unavailable (IDCW-only family)', () => {
    const plans: FamilyPlan[] = [
      makePlan(6001, 'direct', 'idcw_payout'),
      makePlan(6002, 'regular', 'idcw_payout'),
    ];
    const result = resolveFamilyToScheme(plans, directGrowth);
    expect(result).toMatchObject({
      schemeCode: 6001,
      isFallback: true,
      fallbackReason: 'Growth-only',
    });
  });

  it('returns any plan when no plan/option matches at all (last resort)', () => {
    // A weird family with only a bonus option
    const plans: FamilyPlan[] = [makePlan(7001, null, 'bonus')];
    const result = resolveFamilyToScheme(plans, directGrowth);
    expect(result).toMatchObject({
      schemeCode: 7001,
      isFallback: true,
      fallbackReason: 'Different plan available',
    });
  });

  it('handles idcw variant aliases (idcw, dividend_payout, dividend_reinvest)', () => {
    const idcwVariants: FamilyPlan[] = [
      makePlan(8001, 'direct', 'idcw'),
      makePlan(8002, 'direct', 'dividend_payout'),
      makePlan(8003, 'direct', 'dividend_reinvest'),
    ];
    // All three should match IDCW preference; payout ranks first.
    const result = resolveFamilyToScheme(idcwVariants, directIdcw);
    expect(result).toMatchObject({ schemeCode: 8002, isFallback: false });
  });

  it('within Regular-only fallback, prefers idcw_payout for IDCW preference', () => {
    const plans: FamilyPlan[] = [
      makePlan(9001, 'regular', 'idcw_reinvest'),
      makePlan(9002, 'regular', 'idcw_payout'),
    ];
    const result = resolveFamilyToScheme(plans, directIdcw);
    expect(result).toMatchObject({
      schemeCode: 9002,
      isFallback: true,
      fallbackReason: 'Regular-only',
    });
  });

  it('Regular · IDCW preference with full plan matrix resolves exact match', () => {
    const plans: FamilyPlan[] = [
      makePlan(10001, 'direct', 'growth'),
      makePlan(10002, 'regular', 'growth'),
      makePlan(10003, 'direct', 'idcw_payout'),
      makePlan(10004, 'regular', 'idcw_payout'),
    ];
    const result = resolveFamilyToScheme(plans, regularIdcw);
    expect(result).toMatchObject({ schemeCode: 10004, isFallback: false });
  });

  it('exercises idcwRank default branch via multi-growth-plan sort', () => {
    // Two plans with the same planType and optionType='growth' force the sort
    // comparator to call idcwRank('growth'), which hits the default: return 99 branch.
    const plans: FamilyPlan[] = [
      makePlan(12001, 'direct', 'growth'),
      makePlan(12002, 'direct', 'growth'),
    ];
    const result = resolveFamilyToScheme(plans, directGrowth);
    expect(result?.isFallback).toBe(false);
    expect([12001, 12002]).toContain(result?.schemeCode);
  });

  it('prefers Growth when planType matches but optionType does not', () => {
    // Prefer growth over idcw when the preferred option is not available
    // but plan type matches.
    const plans: FamilyPlan[] = [
      makePlan(11001, 'direct', 'growth'),
      makePlan(11002, 'direct', 'idcw_payout'),
    ];
    // Prefer Direct · Growth → exact match.
    const resultGrowth = resolveFamilyToScheme(plans, directGrowth);
    expect(resultGrowth).toMatchObject({ schemeCode: 11001, isFallback: false });

    // Prefer Direct · IDCW → exact match.
    const resultIdcw = resolveFamilyToScheme(plans, directIdcw);
    expect(resultIdcw).toMatchObject({ schemeCode: 11002, isFallback: false });
  });
});

// ---------------------------------------------------------------------------
// fetchFamilyPlans
// ---------------------------------------------------------------------------

describe('fetchFamilyPlans', () => {
  it('returns mapped FamilyPlan rows for a family ID', async () => {
    returnedRows = [
      { scheme_code: 119597, plan_type: 'direct', option_type: 'growth' },
      { scheme_code: 119598, plan_type: 'regular', option_type: 'growth' },
      { scheme_code: 119599, plan_type: 'direct', option_type: 'idcw_payout' },
    ];
    const plans: FamilyPlan[] = await fetchFamilyPlans('OF-abc123');
    expect(plans).toHaveLength(3);
    expect(plans[0]).toEqual({ schemeCode: 119597, planType: 'direct', optionType: 'growth' });
    expect(plans[1]).toEqual({ schemeCode: 119598, planType: 'regular', optionType: 'growth' });
    expect(plans[2]).toEqual({ schemeCode: 119599, planType: 'direct', optionType: 'idcw_payout' });
    expect(lastSchemeMasterBuilder.eq).toHaveBeenCalledWith('of_family_id', 'OF-abc123');
  });

  it('returns empty array when no plans found', async () => {
    returnedRows = [];
    const plans = await fetchFamilyPlans('OF-no-plans');
    expect(plans).toEqual([]);
  });

  it('handles null plan_type and option_type gracefully', async () => {
    returnedRows = [{ scheme_code: 200001, plan_type: null, option_type: null }];
    const plans = await fetchFamilyPlans('OF-nullish');
    expect(plans[0]).toEqual({ schemeCode: 200001, planType: null, optionType: null });
  });
});

// ---------------------------------------------------------------------------
// fetchUserHeldSchemes (single-mode held-fund lookup)
// ---------------------------------------------------------------------------

describe('fetchUserHeldSchemes', () => {
  beforeEach(() => {
    lastSchemeMasterBuilder = undefined as unknown as QB;
  });

  it('returns empty array when user holds no active funds', async () => {
    returnedUserFundRows = [];
    const out = await fetchUserHeldSchemes('user-1');
    expect(out).toEqual([]);
    expect(lastSchemeMasterBuilder).toBeUndefined();
  });

  it('returns mapped SchemeSearchResult rows for held scheme codes', async () => {
    returnedUserFundRows = [{ scheme_code: 119597 }, { scheme_code: 119598 }];
    returnedRows = [
      {
        scheme_code: 119597,
        scheme_name: 'HDFC Large Cap Fund - Direct Growth',
        scheme_category: 'Equity',
        sebi_category: 'large cap fund',
        amc_name: 'HDFC Mutual Fund',
        plan_type: 'direct',
        isin: 'INF179K01WT1',
        scheme_active: true,
        openfolio_meta_synced_at: '2026-06-01T00:00:00Z',
      },
    ];
    const out: SchemeSearchResult[] = await fetchUserHeldSchemes('user-1');
    expect(out).toHaveLength(1);
    expect(out[0].schemeCode).toBe(119597);
    expect(out[0].schemeName).toBe('HDFC Large Cap Fund - Direct Growth');
    expect(lastSchemeMasterBuilder.in).toHaveBeenCalledWith('scheme_code', [119597, 119598]);
    expect(lastUserFundBuilder.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(lastUserFundBuilder.eq).toHaveBeenCalledWith('is_active', true);
  });

  it('deduplicates scheme codes from multiple holdings of the same fund', async () => {
    returnedUserFundRows = [{ scheme_code: 119597 }, { scheme_code: 119597 }];
    returnedRows = [];
    await fetchUserHeldSchemes('user-1');
    // Deduped to a single code in the .in() call
    expect(lastSchemeMasterBuilder.in).toHaveBeenCalledWith('scheme_code', [119597]);
  });
});

// ---------------------------------------------------------------------------
// fetchUserHeldFamilies (family-first picker held-fund lookup)
// ---------------------------------------------------------------------------

describe('fetchUserHeldFamilies', () => {
  beforeEach(() => {
    lastSchemeMasterBuilder = undefined as unknown as QB;
  });

  it('returns empty array when user holds no active funds', async () => {
    returnedUserFundRows = [];
    const out = await fetchUserHeldFamilies('user-1');
    expect(out).toEqual([]);
  });

  it('returns empty array when no held schemes have of_family_id', async () => {
    returnedUserFundRows = [{ scheme_code: 300001 }];
    returnedRows = []; // schemeMaster returns no rows with of_family_id
    const out = await fetchUserHeldFamilies('user-1');
    expect(out).toEqual([]);
  });

  it('returns mapped FamilySearchResult rows for held family IDs', async () => {
    returnedUserFundRows = [{ scheme_code: 119597 }, { scheme_code: 119598 }];
    returnedRows = [
      { of_family_id: 'OF-abc' },
      { of_family_id: 'OF-abc' }, // duplicate → deduped
      { of_family_id: 'OF-xyz' },
    ];
    returnedFamilyRows = [
      {
        of_family_id: 'OF-abc',
        family_name: 'HDFC Large & Mid Cap Fund',
        amc_name: 'HDFC Mutual Fund',
        sebi_category: 'large & mid cap fund',
        scheme_category: 'Equity',
        has_direct: true,
        has_regular: true,
        has_growth: true,
        has_idcw: false,
        representative_scheme_code: 119597,
        family_active: true,
      },
      {
        of_family_id: 'OF-xyz',
        family_name: 'Axis Small Cap Fund',
        amc_name: 'Axis Mutual Fund',
        sebi_category: 'small cap fund',
        scheme_category: 'Equity',
        has_direct: true,
        has_regular: false,
        has_growth: true,
        has_idcw: true,
        representative_scheme_code: 120456,
        family_active: true,
      },
    ];
    const out: FamilySearchResult[] = await fetchUserHeldFamilies('user-1');
    expect(out).toHaveLength(2);
    expect(out[0].ofFamilyId).toBe('OF-abc');
    expect(out[1].ofFamilyId).toBe('OF-xyz');
    // Verify family search repo was queried with deduplicated IDs
    expect(lastFamilySearchBuilder.in).toHaveBeenCalledWith(
      'of_family_id',
      expect.arrayContaining(['OF-abc', 'OF-xyz']),
    );
  });

  it('queries userFund with correct user_id and is_active filters', async () => {
    returnedUserFundRows = [{ scheme_code: 119597 }];
    returnedRows = [{ of_family_id: 'OF-abc' }];
    returnedFamilyRows = [];
    await fetchUserHeldFamilies('user-42');
    expect(lastUserFundBuilder.eq).toHaveBeenCalledWith('user_id', 'user-42');
    expect(lastUserFundBuilder.eq).toHaveBeenCalledWith('is_active', true);
    expect(lastSchemeMasterBuilder.not).toHaveBeenCalledWith('of_family_id', 'is', null);
  });
});
