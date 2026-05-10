import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  fetchCachedIndexRows,
  fetchCachedNavRows,
  mergeCompactRows,
} from '@/src/lib/referenceDataCache';
import { supabase } from '@/src/lib/supabase';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

jest.mock('@/src/lib/supabase', () => ({ supabase: { from: jest.fn() } }));

const mockedStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const mockFrom = supabase.from as jest.Mock;

function makeChain(response: { data: unknown[] | null; error: { message: string } | null }): any {
  const chain = {
    data: response.data,
    error: response.error,
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    gte: jest.fn(),
    gt: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
  };
  (['select', 'eq', 'in', 'gte', 'gt', 'order'] as const).forEach((method) => {
    chain[method].mockReturnValue(chain);
  });
  chain.range.mockImplementation(() => Promise.resolve(response));
  return chain;
}

describe('mergeCompactRows', () => {
  it('sorts by date, drops invalid rows, and lets incoming rows replace duplicates', () => {
    expect(
      mergeCompactRows(
        [
          ['2024-01-03', 103],
          ['not-a-date', 999],
          ['2024-01-01', 100],
        ],
        [
          ['2024-01-02', 102],
          ['2024-01-01', 101],
          ['2024-01-04', Number.NaN],
        ],
      ),
    ).toEqual([
      ['2024-01-01', 101],
      ['2024-01-02', 102],
      ['2024-01-03', 103],
    ]);
  });
});

describe('reference data cache', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    mockedStorage.getItem.mockImplementation(async (key) => storage.get(key) ?? null);
    mockedStorage.setItem.mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    mockedStorage.removeItem.mockImplementation(async (key) => {
      storage.delete(key);
    });
  });

  it('fetches and stores a full index range on cache miss', async () => {
    const chain = makeChain({
      data: [
        { index_date: '2024-01-01', close_value: 100 },
        { index_date: '2024-01-02', close_value: 101 },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(chain);

    const rows = await fetchCachedIndexRows('^NSEITRI', '2024-01-01');

    expect(rows).toEqual([
      { index_date: '2024-01-01', close_value: 100 },
      { index_date: '2024-01-02', close_value: 101 },
    ]);
    expect(chain.gte).toHaveBeenCalledWith('index_date', '2024-01-01');
    expect(chain.gt).not.toHaveBeenCalled();
    expect(storage.size).toBe(1);
  });

  it('uses a delta index fetch when the cached range covers the request', async () => {
    mockFrom.mockReturnValueOnce(makeChain({
      data: [{ index_date: '2024-01-01', close_value: 100 }],
      error: null,
    }));
    await fetchCachedIndexRows('^NSEITRI', '2024-01-01');

    const deltaChain = makeChain({
      data: [{ index_date: '2024-01-02', close_value: 101 }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(deltaChain);

    const rows = await fetchCachedIndexRows('^NSEITRI', '2024-01-01');

    expect(deltaChain.gt).toHaveBeenCalledWith('index_date', '2024-01-01');
    expect(deltaChain.gte).not.toHaveBeenCalled();
    expect(rows).toEqual([
      { index_date: '2024-01-01', close_value: 100 },
      { index_date: '2024-01-02', close_value: 101 },
    ]);
  });

  it('refetches the full requested range when an older start date is requested', async () => {
    mockFrom.mockReturnValueOnce(makeChain({
      data: [{ index_date: '2024-01-02', close_value: 102 }],
      error: null,
    }));
    await fetchCachedIndexRows('^NSEITRI', '2024-01-02');

    const fullChain = makeChain({
      data: [
        { index_date: '2024-01-01', close_value: 100 },
        { index_date: '2024-01-02', close_value: 102 },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(fullChain);

    const rows = await fetchCachedIndexRows('^NSEITRI', '2024-01-01');

    expect(fullChain.gte).toHaveBeenCalledWith('index_date', '2024-01-01');
    expect(fullChain.gt).not.toHaveBeenCalled();
    expect(rows[0]).toEqual({ index_date: '2024-01-01', close_value: 100 });
  });

  it('removes corrupt cache entries and falls back to a full index fetch', async () => {
    mockFrom.mockReturnValueOnce(makeChain({
      data: [{ index_date: '2024-01-01', close_value: 100 }],
      error: null,
    }));
    await fetchCachedIndexRows('^NSEITRI', '2024-01-01');
    const cacheKey = [...storage.keys()][0];
    storage.set(cacheKey, '{bad json');

    const repairChain = makeChain({
      data: [{ index_date: '2024-01-01', close_value: 100 }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(repairChain);

    await fetchCachedIndexRows('^NSEITRI', '2024-01-01');

    expect(mockedStorage.removeItem).toHaveBeenCalledWith(cacheKey);
    expect(repairChain.gte).toHaveBeenCalledWith('index_date', '2024-01-01');
  });

  it('merges NAV deltas per scheme and returns rows for all requested schemes', async () => {
    const initialChain = makeChain({
      data: [
        { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
        { scheme_code: 200, nav_date: '2024-01-01', nav: 20 },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(initialChain);
    await fetchCachedNavRows([100, 200], '2024-01-01');

    const deltaChain = makeChain({
      data: [
        { scheme_code: 100, nav_date: '2024-01-02', nav: 11 },
        { scheme_code: 200, nav_date: '2024-01-02', nav: 21 },
      ],
      error: null,
    });
    mockFrom.mockReturnValueOnce(deltaChain);

    const rows = await fetchCachedNavRows([100, 200], '2024-01-01');

    expect(deltaChain.gt).toHaveBeenCalledWith('nav_date', '2024-01-01');
    expect(rows).toEqual([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 200, nav_date: '2024-01-01', nav: 20 },
      { scheme_code: 100, nav_date: '2024-01-02', nav: 11 },
      { scheme_code: 200, nav_date: '2024-01-02', nav: 21 },
    ]);
  });
});
