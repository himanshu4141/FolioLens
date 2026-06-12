/**
 * Tests for the fund search query builder. We mock at the data-wrapper
 * boundary (`@/src/lib/data/schemeMaster`), never the supabase module, per the
 * repo convention. The chainable query builder is a hand-rolled spy so we can
 * assert the exact filter calls searchSchemes issues per token.
 */
import { searchSchemes, tokenizeQuery, type SchemeSearchResult } from '../fundSearch';

// --- chainable query-builder mock ------------------------------------------

interface QB {
  select: jest.Mock;
  order: jest.Mock;
  range: jest.Mock;
  or: jest.Mock;
  eq: jest.Mock;
  then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => Promise<unknown>;
}

let lastBuilder: QB;
let returnedRows: Record<string, unknown>[] = [];

function makeBuilder(): QB {
  const qb = {} as QB;
  const chain = () => qb;
  qb.select = jest.fn(chain);
  qb.order = jest.fn(chain);
  qb.range = jest.fn(chain);
  qb.or = jest.fn(chain);
  qb.eq = jest.fn(chain);
  // Make it awaitable — resolves to a supabase-style { data, error }.
  qb.then = (resolve) => Promise.resolve(resolve({ data: returnedRows, error: null }));
  return qb;
}

jest.mock('@/src/lib/data/schemeMaster', () => ({
  schemeMasterRepo: {
    from: () => {
      lastBuilder = makeBuilder();
      return lastBuilder;
    },
  },
}));

jest.mock('@/src/lib/data/userFund', () => ({
  userFundRepo: { from: jest.fn() },
}));

beforeEach(() => {
  returnedRows = [];
});

describe('tokenizeQuery', () => {
  it('splits on whitespace, lowercases, strips punctuation', () => {
    expect(tokenizeQuery('Large & Mid Cap Direct')).toEqual(['large', 'mid', 'cap', 'direct']);
  });

  it('drops fragments shorter than 2 chars (incl. bare "&")', () => {
    // "&" → "" (dropped); "a" → dropped; keeps real tokens.
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

describe('searchSchemes — token AND across columns', () => {
  it('issues one OR-group per token (so all tokens must match)', async () => {
    await searchSchemes({ query: 'large & mid cap direct' });
    // 4 real tokens (the "&" is dropped) → 4 .or() calls.
    expect(lastBuilder.or).toHaveBeenCalledTimes(4);
    const groups = lastBuilder.or.mock.calls.map((c) => c[0]);
    expect(groups[0]).toBe(
      'scheme_name.ilike.%large%,sebi_category.ilike.%large%,amc_name.ilike.%large%',
    );
    expect(groups).toContain(
      'scheme_name.ilike.%direct%,sebi_category.ilike.%direct%,amc_name.ilike.%direct%',
    );
  });

  it('does not call .or() when the query is empty (returns first page)', async () => {
    await searchSchemes({ query: '' });
    expect(lastBuilder.or).not.toHaveBeenCalled();
  });

  it('applies amcName and category as eq filters', async () => {
    await searchSchemes({ query: 'cap', amcName: 'HDFC Mutual Fund', category: 'Equity' });
    expect(lastBuilder.eq).toHaveBeenCalledWith('amc_name', 'HDFC Mutual Fund');
    expect(lastBuilder.eq).toHaveBeenCalledWith('scheme_category', 'Equity');
  });

  it('maps rows including the new sebiCategory field', async () => {
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
    });
  });

  it('orders by scheme_active DESC NULLS LAST, then scheme_name ASC', async () => {
    await searchSchemes({ query: 'cap' });
    // Should call .order() twice: first for scheme_active, then scheme_name
    expect(lastBuilder.order).toHaveBeenCalledTimes(2);
    expect(lastBuilder.order).toHaveBeenNthCalledWith(1, 'scheme_active', {
      ascending: false,
      nullsLast: true,
    });
    expect(lastBuilder.order).toHaveBeenNthCalledWith(2, 'scheme_name', {
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
      },
    ];
    const out: SchemeSearchResult[] = await searchSchemes({ query: 'fund' });
    expect(out).toHaveLength(3);
    // active true should come first
    expect(out[0].schemeActive).toBe(true);
    // active false should come next
    expect(out[1].schemeActive).toBe(false);
    // null should come last (nullsLast)
    expect(out[2].schemeActive).toBe(null);
  });
});
