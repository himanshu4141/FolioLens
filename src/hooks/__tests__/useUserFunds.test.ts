/**
 * Tests for fetchUserFunds's persisted select shape.
 *
 * `['user-funds', userId]` is in the React Query persist allowlist
 * (src/lib/queryClient.ts), so adding a column here changes what's written to
 * AsyncStorage. M2.2b (docs/plans/amfi-nav-format-change.md) adds
 * `family_name`/`plan_type`/`option_type` from the `fund` view and bumps
 * `__BUSTER__` to v14 — these tests pin that the new columns are actually
 * selected and round-trip through the mapper, present and null.
 */
jest.mock('@/src/lib/data/userFund', () => ({
  fundViewRepo: { from: jest.fn() },
}));

// eslint-disable-next-line import/first -- mock must register before module imports
import { fetchUserFunds } from '@/src/hooks/useUserFunds';
// eslint-disable-next-line import/first
import { fundViewRepo } from '@/src/lib/data/userFund';

const fundFrom = fundViewRepo.from as jest.Mock;

function mockRows(rows: Record<string, unknown>[], error: unknown = null) {
  const select = jest.fn();
  const eq = jest.fn().mockResolvedValue({ data: rows, error });
  select.mockReturnValue({ eq });
  fundFrom.mockReturnValue({ select });
  return { select };
}

const BASE_ROW: Record<string, unknown> = {
  id: 'fund-1',
  user_id: 'user-1',
  scheme_code: 119551,
  scheme_name: 'Axis Bluechip Fund - Direct Plan - Growth',
  scheme_category: 'Equity',
  benchmark_index: 'Nifty 50',
  benchmark_index_symbol: '^NSEI',
  isin: 'INF846K01EW2',
  expense_ratio: 0.5,
  aum_cr: 1000,
  min_sip_amount: 500,
  fund_meta_synced_at: '2026-09-01T00:00:00.000Z',
  is_active: true,
  scheme_active: true,
};

describe('fetchUserFunds — family_name/plan_type/option_type persisted shape (M2.2b)', () => {
  afterEach(() => jest.clearAllMocks());

  it('includes family_name, plan_type, and option_type in the select column list', async () => {
    const { select } = mockRows([{ ...BASE_ROW, family_name: 'Axis Bluechip Fund', plan_type: 'direct', option_type: 'growth' }]);
    await fetchUserFunds('user-1');
    const selectArg = select.mock.calls[0][0] as string;
    expect(selectArg).toContain('family_name');
    expect(selectArg).toContain('plan_type');
    expect(selectArg).toContain('option_type');
  });

  it('round-trips non-null family_name/plan_type/option_type values', async () => {
    mockRows([{ ...BASE_ROW, family_name: 'Axis Bluechip Fund', plan_type: 'direct', option_type: 'growth' }]);
    const rows = await fetchUserFunds('user-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].family_name).toBe('Axis Bluechip Fund');
    expect(rows[0].plan_type).toBe('direct');
    expect(rows[0].option_type).toBe('growth');
  });

  it('round-trips null family_name/plan_type/option_type (not yet classified)', async () => {
    mockRows([{ ...BASE_ROW, family_name: null, plan_type: null, option_type: null }]);
    const rows = await fetchUserFunds('user-1');
    expect(rows[0].family_name).toBeNull();
    expect(rows[0].plan_type).toBeNull();
    expect(rows[0].option_type).toBeNull();
  });

  it('returns an empty array when the user holds no funds', async () => {
    mockRows([]);
    const rows = await fetchUserFunds('user-1');
    expect(rows).toEqual([]);
  });
});
