import {
  fetchIndexHistoryDirect,
  fetchNavHistoryDirect,
  indexHistoryQueryKey,
  navHistoryQueryKey,
} from '@/src/lib/sharedHistoryCache';
import { supabase } from '@/src/lib/supabase';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/lib/supabase', () => ({ supabase: { from: jest.fn() } }));

interface Chain {
  data: unknown;
  error: unknown;
  select: jest.Mock;
  in: jest.Mock;
  eq: jest.Mock;
  gte: jest.Mock;
  order: jest.Mock;
  range: jest.Mock;
}

function makeChain(response: { data: unknown; error: unknown }): Chain {
  const chain = {
    data: response.data,
    error: response.error,
    select: jest.fn(),
    in: jest.fn(),
    eq: jest.fn(),
    gte: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
  } as unknown as Chain;
  // Each chain call resolves to the response itself when awaited (PostgREST
  // builders are thenables). For our tests we configure `.range()` (the
  // terminal call in our pagination loop) to return the response directly.
  chain.select.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.gte.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.range.mockReturnValue(response);
  return chain;
}

const mockFrom = supabase.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('navHistoryQueryKey()', () => {
  it('sorts scheme codes so the cache key is order-independent', () => {
    expect(navHistoryQueryKey('user-1', [3, 1, 2])).toEqual([
      'nav-history',
      'user-1',
      [1, 2, 3],
    ]);
  });

  it('does not mutate the caller-provided array', () => {
    const codes = [3, 1, 2];
    navHistoryQueryKey('user-1', codes);
    expect(codes).toEqual([3, 1, 2]);
  });
});

describe('indexHistoryQueryKey()', () => {
  it('keys by the symbol string', () => {
    expect(indexHistoryQueryKey('^NSEI')).toEqual(['index-history', '^NSEI']);
  });
});

describe('fetchNavHistoryDirect()', () => {
  it('returns an empty array and skips the network when no scheme codes are requested', async () => {
    const result = await fetchNavHistoryDirect([], []);
    expect(result).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('runs a full-history SELECT (no `gte`) when the cache is empty', async () => {
    const chain = makeChain({
      data: [
        { scheme_code: 12345, nav_date: '2026-05-09', nav: 142 },
        { scheme_code: 12345, nav_date: '2026-05-08', nav: 141 },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const result = await fetchNavHistoryDirect([12345], []);

    expect(mockFrom).toHaveBeenCalledWith('nav_history');
    expect(chain.in).toHaveBeenCalledWith('scheme_code', [12345]);
    expect(chain.gte).not.toHaveBeenCalled();
    expect(result).toEqual([
      { scheme_code: 12345, nav_date: '2026-05-09', nav: 142 },
      { scheme_code: 12345, nav_date: '2026-05-08', nav: 141 },
    ]);
  });

  it('runs a delta SELECT with `gte` when cache has prior rows', async () => {
    const cached = [
      { scheme_code: 12345, nav_date: '2026-05-08', nav: 141 },
      { scheme_code: 12345, nav_date: '2026-05-07', nav: 140 },
      { scheme_code: 67890, nav_date: '2026-05-08', nav: 23 },
    ];
    const chain = makeChain({
      data: [{ scheme_code: 12345, nav_date: '2026-05-09', nav: 142 }],
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const result = await fetchNavHistoryDirect([12345, 67890], cached);

    expect(chain.gte).toHaveBeenCalledWith('nav_date', '2026-05-08');
    // Merged (delta + cache), deduped, sorted desc-date then asc-key.
    expect(result).toEqual([
      { scheme_code: 12345, nav_date: '2026-05-09', nav: 142 },
      { scheme_code: 12345, nav_date: '2026-05-08', nav: 141 },
      { scheme_code: 67890, nav_date: '2026-05-08', nav: 23 },
      { scheme_code: 12345, nav_date: '2026-05-07', nav: 140 },
    ]);
  });

  it('falls back to full fetch when adding a brand-new scheme to a warm cache', async () => {
    const cached = [{ scheme_code: 12345, nav_date: '2026-05-08', nav: 141 }];
    const chain = makeChain({
      data: [
        { scheme_code: 12345, nav_date: '2026-05-09', nav: 142 },
        { scheme_code: 99999, nav_date: '2026-05-09', nav: 50 },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    await fetchNavHistoryDirect([12345, 99999], cached);

    // 99999 has nothing cached → minDate null → no `gte` → full fetch.
    expect(chain.gte).not.toHaveBeenCalled();
  });

  it('throws when the SELECT returns an error', async () => {
    const chain = makeChain({ data: null, error: { message: 'boom' } });
    mockFrom.mockReturnValue(chain);

    await expect(fetchNavHistoryDirect([12345], [])).rejects.toEqual({
      message: 'boom',
    });
  });
});

describe('fetchIndexHistoryDirect()', () => {
  it('returns an empty array and skips the network when no symbol is requested', async () => {
    const result = await fetchIndexHistoryDirect('', []);
    expect(result).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('runs a full-history SELECT when the cache is empty', async () => {
    const chain = makeChain({
      data: [
        { index_date: '2026-05-09', close_value: 22050 },
        { index_date: '2026-05-08', close_value: 22000 },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const result = await fetchIndexHistoryDirect('^NSEI', []);

    expect(mockFrom).toHaveBeenCalledWith('index_history');
    expect(chain.eq).toHaveBeenCalledWith('index_symbol', '^NSEI');
    expect(chain.gte).not.toHaveBeenCalled();
    expect(result).toEqual([
      { index_date: '2026-05-09', close_value: 22050 },
      { index_date: '2026-05-08', close_value: 22000 },
    ]);
  });

  it('runs a delta SELECT with `gte` when cache has prior rows', async () => {
    const cached = [
      { index_date: '2026-05-08', close_value: 22000 },
      { index_date: '2026-05-07', close_value: 21950 },
    ];
    const chain = makeChain({
      data: [{ index_date: '2026-05-09', close_value: 22050 }],
      error: null,
    });
    mockFrom.mockReturnValue(chain);

    const result = await fetchIndexHistoryDirect('^NSEI', cached);

    expect(chain.gte).toHaveBeenCalledWith('index_date', '2026-05-08');
    expect(result).toEqual([
      { index_date: '2026-05-09', close_value: 22050 },
      { index_date: '2026-05-08', close_value: 22000 },
      { index_date: '2026-05-07', close_value: 21950 },
    ]);
  });

  it('throws on Supabase error', async () => {
    const chain = makeChain({ data: null, error: { message: 'idx-boom' } });
    mockFrom.mockReturnValue(chain);

    await expect(fetchIndexHistoryDirect('^NSEI', [])).rejects.toEqual({
      message: 'idx-boom',
    });
  });
});
