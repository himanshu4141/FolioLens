/**
 * Tests for the CDN-snapshot-with-fallback fetcher (Phase 9 M5).
 *
 * The helper has three live behaviours:
 *
 *   1. Happy path: snapshot fetch succeeds → return its points,
 *      optionally filtered by `sinceDate`.
 *   2. 404 path: bucket returns 404 → fall back to the paginated
 *      `index_history` SELECT.
 *   3. Network / parse failure: any throw or non-OK status → fall
 *      back to the SELECT.
 *
 * Tests mock the global `fetch` for the snapshot URL and mock
 * `supabase.from` for the fallback path. No network calls are made.
 */
import { fetchIndexHistory, fetchIndexSnapshot } from '../useIndexSnapshot';
import { supabase } from '@/src/lib/supabase';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/lib/supabase', () => ({ supabase: { from: jest.fn() } }));

// The helper builds URLs from EXPO_PUBLIC_SUPABASE_URL. We set a stable
// value here so URL construction is deterministic.
const STORAGE_BASE = 'https://test-project.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_URL = STORAGE_BASE;

const expectedUrlFor = (symbol: string) =>
  `${STORAGE_BASE}/storage/v1/object/public/static-snapshots/index/${symbol.replace(/^\^/, '').toLowerCase()}.json`;

// Minimal supabase chain mock — mirrors the pattern in
// usePortfolio.test.ts so the paginated fallback can be exercised.
function makeChain(response: { data: unknown; error: unknown }): any {
  const chain: any = {
    data: response.data,
    error: response.error,
    select: jest.fn(),
    eq: jest.fn(),
    gte: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
  };
  ['select', 'eq', 'gte', 'order'].forEach((m) =>
    (chain as Record<string, jest.Mock>)[m].mockReturnValue(chain),
  );
  chain.range.mockReturnValue(response);
  return chain;
}

const mockFrom = supabase.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Reset global fetch to a fresh jest.fn each test.
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
});

describe('fetchIndexSnapshot()', () => {
  it('returns parsed snapshot on 200 OK', async () => {
    const payload = {
      symbol: '^NSEITRI',
      generated_at: '2026-05-12T14:00:00Z',
      points: [
        { date: '2024-01-01', value: 100 },
        { date: '2024-01-02', value: 101 },
      ],
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    });

    const result = await fetchIndexSnapshot('^NSEITRI');
    expect(result).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith(
      expectedUrlFor('^NSEITRI'),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });

  it('returns null on 404', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await fetchIndexSnapshot('^NSEITRI')).toBeNull();
  });

  it('returns null on network error', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    expect(await fetchIndexSnapshot('^NSEITRI')).toBeNull();
  });

  it('returns null on malformed payload (no points array)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ symbol: '^NSEITRI', generated_at: 'now' }),
    });
    expect(await fetchIndexSnapshot('^NSEITRI')).toBeNull();
  });

  it('strips leading ^ and lowercases symbol in the URL path', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ symbol: '^NIFTY500TRI', generated_at: 'now', points: [] }),
    });
    await fetchIndexSnapshot('^NIFTY500TRI');
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toMatch(/nifty500tri\.json$/);
  });
});

describe('fetchIndexHistory()', () => {
  it('returns snapshot points unfiltered when no sinceDate', async () => {
    const points = [
      { date: '2020-01-01', value: 100 },
      { date: '2022-06-01', value: 150 },
      { date: '2024-12-31', value: 200 },
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ symbol: '^NSEITRI', generated_at: 'now', points }),
    });
    const result = await fetchIndexHistory('^NSEITRI');
    expect(result).toEqual(points);
  });

  it('filters snapshot points to >= sinceDate', async () => {
    const points = [
      { date: '2020-01-01', value: 100 },
      { date: '2022-06-01', value: 150 },
      { date: '2024-12-31', value: 200 },
    ];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ symbol: '^NSEITRI', generated_at: 'now', points }),
    });
    const result = await fetchIndexHistory('^NSEITRI', '2022-01-01');
    expect(result).toEqual([
      { date: '2022-06-01', value: 150 },
      { date: '2024-12-31', value: 200 },
    ]);
  });

  it('falls back to paginated index_history SELECT on snapshot 404', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    mockFrom.mockReturnValue(
      makeChain({
        data: [
          { index_date: '2024-01-01', close_value: 100 },
          { index_date: '2024-01-02', close_value: 101 },
        ],
        error: null,
      }),
    );

    const result = await fetchIndexHistory('^NSEITRI', '2024-01-01');
    expect(result).toEqual([
      { date: '2024-01-01', value: 100 },
      { date: '2024-01-02', value: 101 },
    ]);
    expect(mockFrom).toHaveBeenCalledWith('index_history');
  });

  it('falls back on network error', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    mockFrom.mockReturnValue(
      makeChain({
        data: [{ index_date: '2024-01-01', close_value: 100 }],
        error: null,
      }),
    );
    const result = await fetchIndexHistory('^NSEITRI');
    expect(result).toEqual([{ date: '2024-01-01', value: 100 }]);
  });

  it('throws when both snapshot and fallback fail', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    mockFrom.mockReturnValue(makeChain({ data: null, error: { message: 'DB down' } }));
    await expect(fetchIndexHistory('^NSEITRI')).rejects.toMatchObject({ message: 'DB down' });
  });
});
