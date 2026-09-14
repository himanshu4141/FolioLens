/**
 * Tests for fetchSchemeMaster's persisted select shape.
 *
 * `['scheme-master', code]` is in the React Query persist allowlist
 * (src/lib/queryClient.ts), so adding a column here changes what's written to
 * AsyncStorage. M2 (docs/plans/amfi-nav-format-change.md) adds
 * `plan_option_source` and bumps `__BUSTER__` to v13 — these tests pin that
 * the new column is actually selected and round-trips through the mapper,
 * with both a present and a null value.
 */
jest.mock('@/src/lib/data/schemeMaster', () => ({
  schemeMasterRepo: { from: jest.fn() },
}));

// eslint-disable-next-line import/first -- mock must register before module imports
import { fetchSchemeMaster, type SchemeMasterDbRow } from '@/src/hooks/useSchemeMaster';
// eslint-disable-next-line import/first
import { schemeMasterRepo } from '@/src/lib/data/schemeMaster';

const schemeFrom = schemeMasterRepo.from as jest.Mock;

function mockRow(row: Record<string, unknown> | null, error: unknown = null) {
  const select = jest.fn();
  const eq = jest.fn();
  const maybeSingle = jest.fn().mockResolvedValue({ data: row, error });
  select.mockReturnValue({ eq: eq.mockReturnValue({ maybeSingle }) });
  schemeFrom.mockReturnValue({ select });
  return { select };
}

const BASE_ROW: Record<string, unknown> = {
  scheme_code: 119551,
  scheme_name: 'Axis Bluechip Fund',
  scheme_category: 'Equity',
  sebi_category: 'large cap fund',
  benchmark_index: 'Nifty 50',
  declared_benchmark_name: null,
  expense_ratio: 0.5,
  aum_cr: 1000,
  isin: 'INF846K01EW2',
  amc_name: 'Axis',
  family_name: 'Axis Bluechip Fund',
  plan_type: 'direct',
  option_type: 'growth',
  launch_date: null,
  exit_load: null,
  min_sip_amount: 500,
  min_lumpsum: 5000,
  min_additional: null,
  risk_label: null,
  period_returns: null,
  risk_ratios: null,
  fund_manager: null,
  portfolio_turnover: null,
  ter_date: null,
};

describe('fetchSchemeMaster — plan_option_source persisted shape (M2)', () => {
  afterEach(() => jest.clearAllMocks());

  it('includes plan_option_source in the select column list', async () => {
    const { select } = mockRow({ ...BASE_ROW, plan_option_source: 'amfi' });
    await fetchSchemeMaster(119551);
    expect(select).toHaveBeenCalledWith(expect.stringContaining('plan_option_source'));
  });

  it('round-trips a non-null plan_option_source value', async () => {
    mockRow({ ...BASE_ROW, plan_option_source: 'amfi' });
    const result = await fetchSchemeMaster(119551);
    expect(result?.plan_option_source).toBe('amfi');
  });

  it('round-trips each provenance value the pipeline can write', async () => {
    for (const source of ['amfi', 'name', 'mfdata']) {
      mockRow({ ...BASE_ROW, plan_option_source: source });
      const result = await fetchSchemeMaster(119551);
      expect(result?.plan_option_source).toBe(source);
    }
  });

  it('round-trips a null plan_option_source (not yet classified)', async () => {
    mockRow({ ...BASE_ROW, plan_option_source: null });
    const result: SchemeMasterDbRow | null = await fetchSchemeMaster(119551);
    expect(result?.plan_option_source).toBeNull();
  });

  it('returns null when the scheme is not found', async () => {
    mockRow(null);
    const result = await fetchSchemeMaster(999999);
    expect(result).toBeNull();
  });
});
