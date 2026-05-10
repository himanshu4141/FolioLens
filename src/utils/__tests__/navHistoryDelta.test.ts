import {
  deltaQueryWindow,
  deriveLatestByKey,
  mergeDeltaRows,
} from '@/src/utils/navHistoryDelta';

describe('deriveLatestByKey()', () => {
  it('returns an empty object for an empty input', () => {
    expect(deriveLatestByKey([])).toEqual({});
  });

  it('returns the only date for a single-row input', () => {
    expect(deriveLatestByKey([{ key: 1, date: '2026-05-01' }])).toEqual({
      1: '2026-05-01',
    });
  });

  it('keeps the maximum date per key across multiple rows', () => {
    const rows = [
      { key: 1, date: '2026-04-01' },
      { key: 1, date: '2026-05-01' },
      { key: 2, date: '2026-05-02' },
      { key: 1, date: '2026-04-15' }, // should be ignored
      { key: 2, date: '2026-04-30' }, // should be ignored
    ];
    expect(deriveLatestByKey(rows)).toEqual({ 1: '2026-05-01', 2: '2026-05-02' });
  });

  it('handles ties by keeping the first-seen latest', () => {
    const rows = [
      { key: 1, date: '2026-05-01' },
      { key: 1, date: '2026-05-01' },
    ];
    expect(deriveLatestByKey(rows)).toEqual({ 1: '2026-05-01' });
  });

  it('works with string keys (e.g. index symbols)', () => {
    const rows = [
      { key: '^NSEI', date: '2026-05-01' },
      { key: '^BSESN', date: '2026-05-02' },
    ];
    expect(deriveLatestByKey(rows)).toEqual({
      '^NSEI': '2026-05-01',
      '^BSESN': '2026-05-02',
    });
  });
});

describe('deltaQueryWindow()', () => {
  it('returns no keys when nothing is requested', () => {
    expect(deltaQueryWindow([], {})).toEqual({ keys: [], minDate: null });
  });

  it('returns minDate=null when the cache is completely empty', () => {
    expect(deltaQueryWindow([1, 2, 3], {})).toEqual({
      keys: [1, 2, 3],
      minDate: null,
    });
  });

  it('returns the minimum latest date when every requested key is cached', () => {
    expect(
      deltaQueryWindow([1, 2, 3], {
        1: '2026-05-08',
        2: '2026-05-09',
        3: '2026-05-07',
      }),
    ).toEqual({ keys: [1, 2, 3], minDate: '2026-05-07' });
  });

  it('falls back to a full fetch when ANY requested key has no cache', () => {
    // Adding a brand-new fund: we don't yet know what NAVs to delta from
    // for that scheme, so the safe play is a full fetch for everyone.
    expect(
      deltaQueryWindow([1, 2, 3], { 1: '2026-05-08', 2: '2026-05-09' }),
    ).toEqual({ keys: [1, 2, 3], minDate: null });
  });

  it('handles a single key correctly', () => {
    expect(deltaQueryWindow([42], { 42: '2026-05-01' })).toEqual({
      keys: [42],
      minDate: '2026-05-01',
    });
  });

  it('ignores `latestByKey` entries that were not requested', () => {
    // The cache may contain extra keys (e.g. an old fund that the user
    // since deactivated). Those should not affect the delta window for
    // the *currently* requested keys.
    const latest = {
      1: '2026-05-08',
      2: '2026-05-09',
      99: '1999-01-01',
    } as Record<number, string>;
    expect(deltaQueryWindow([1, 2], latest)).toEqual({
      keys: [1, 2],
      minDate: '2026-05-08',
    });
  });
});

describe('mergeDeltaRows()', () => {
  type Row = { key: number; date: string; value: number };

  it('returns the cached rows unchanged when delta is empty', () => {
    const cached: Row[] = [
      { key: 1, date: '2026-05-01', value: 100 },
      { key: 1, date: '2026-04-30', value: 99 },
    ];
    expect(mergeDeltaRows<number, Row>(cached, [])).toEqual(cached);
  });

  it('merges delta into cached, deduping by (key, date)', () => {
    // Delta will land alongside existing rows. Same (key, date)
    // overrides the cached row (delta is the source of truth for
    // anything it actually returned).
    const cached: Row[] = [
      { key: 1, date: '2026-05-01', value: 100 },
      { key: 1, date: '2026-04-30', value: 99 },
    ];
    const delta: Row[] = [
      { key: 1, date: '2026-05-01', value: 100.5 }, // correction
      { key: 1, date: '2026-05-02', value: 101 },
    ];
    expect(mergeDeltaRows<number, Row>(cached, delta)).toEqual([
      { key: 1, date: '2026-05-02', value: 101 },
      { key: 1, date: '2026-05-01', value: 100.5 },
      { key: 1, date: '2026-04-30', value: 99 },
    ]);
  });

  it('sorts descending by date, then ascending by key', () => {
    const cached: Row[] = [
      { key: 2, date: '2026-05-01', value: 50 },
      { key: 1, date: '2026-05-01', value: 100 },
    ];
    const delta: Row[] = [
      { key: 1, date: '2026-05-02', value: 101 },
      { key: 2, date: '2026-05-02', value: 51 },
    ];
    expect(mergeDeltaRows<number, Row>(cached, delta)).toEqual([
      { key: 1, date: '2026-05-02', value: 101 },
      { key: 2, date: '2026-05-02', value: 51 },
      { key: 1, date: '2026-05-01', value: 100 },
      { key: 2, date: '2026-05-01', value: 50 },
    ]);
  });

  it('handles multi-key delta with no cached rows', () => {
    const delta: Row[] = [
      { key: 1, date: '2026-05-01', value: 100 },
      { key: 2, date: '2026-05-01', value: 50 },
    ];
    expect(mergeDeltaRows<number, Row>([], delta)).toEqual([
      { key: 1, date: '2026-05-01', value: 100 },
      { key: 2, date: '2026-05-01', value: 50 },
    ]);
  });

  it('works with string keys', () => {
    type StrRow = { key: string; date: string; close: number };
    const cached: StrRow[] = [{ key: '^NSEI', date: '2026-05-01', close: 22000 }];
    const delta: StrRow[] = [{ key: '^NSEI', date: '2026-05-02', close: 22050 }];
    expect(mergeDeltaRows<string, StrRow>(cached, delta)).toEqual([
      { key: '^NSEI', date: '2026-05-02', close: 22050 },
      { key: '^NSEI', date: '2026-05-01', close: 22000 },
    ]);
  });
});
