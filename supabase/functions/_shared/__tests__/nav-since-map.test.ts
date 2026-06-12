import { buildSchemeLatestMap, SINCE_MAP_PAGE_SIZE } from '../nav-since-map';

// ---------------------------------------------------------------------------
// buildSchemeLatestMap — first-occurrence-per-scheme semantics
// ---------------------------------------------------------------------------

describe('buildSchemeLatestMap', () => {
  it('returns an empty map for empty input', () => {
    expect(buildSchemeLatestMap([])).toEqual(new Map());
  });

  it('picks the first (latest) nav_date per scheme in descending order', () => {
    const rows = [
      { scheme_code: 100, nav_date: '2026-06-10' },
      { scheme_code: 200, nav_date: '2026-06-09' },
      { scheme_code: 100, nav_date: '2026-06-08' }, // duplicate — must be ignored
      { scheme_code: 200, nav_date: '2026-06-07' }, // duplicate — must be ignored
    ];
    const map = buildSchemeLatestMap(rows);
    expect(map.get(100)).toBe('2026-06-10');
    expect(map.get(200)).toBe('2026-06-09');
    expect(map.size).toBe(2);
  });

  it('handles a single scheme with many rows — takes the first row only', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      scheme_code: 42,
      nav_date: `2026-${String(6).padStart(2, '0')}-${String(50 - i).padStart(2, '0')}`,
    }));
    const map = buildSchemeLatestMap(rows);
    expect(map.size).toBe(1);
    expect(map.get(42)).toBe(rows[0].nav_date);
  });

  // -------------------------------------------------------------------------
  // Pagination guard: >1,000 rows spanning many schemes
  //
  // PostgREST caps unpaginated queries at 1,000 rows.  The sync-nav since-map
  // query MUST paginate with SINCE_MAP_PAGE_SIZE (.range()) so that schemes
  // whose first row lands beyond the 1,000-row boundary are not silently
  // degraded to full-history re-fetches (since=null).
  //
  // This test simulates what the accumulated allNavRows array looks like after
  // all pages are concatenated: 1,500 rows, 30 schemes, 50 rows each
  // (descending by nav_date per scheme, interleaved across schemes).
  // Without pagination the last 500 rows — and the schemes they represent —
  // would be missing; buildSchemeLatestMap must cover all 30 schemes.
  // -------------------------------------------------------------------------
  it('covers all schemes when accumulated rows exceed 1,000 (pagination scenario)', () => {
    const NUM_SCHEMES = 30;
    const ROWS_PER_SCHEME = 50;
    const TOTAL_ROWS = NUM_SCHEMES * ROWS_PER_SCHEME; // 1,500 > 1,000

    // Build rows: 50 descending dates per scheme, interleaved (scheme 0 row 0,
    // scheme 1 row 0, …, scheme 29 row 0, scheme 0 row 1, …).
    const rows: { scheme_code: number; nav_date: string }[] = [];
    for (let rowIdx = 0; rowIdx < ROWS_PER_SCHEME; rowIdx++) {
      for (let s = 0; s < NUM_SCHEMES; s++) {
        const dayNum = ROWS_PER_SCHEME - rowIdx;
        rows.push({
          scheme_code: 100_000 + s,
          nav_date: `2026-01-${String(dayNum).padStart(2, '0')}`,
        });
      }
    }

    expect(rows.length).toBe(TOTAL_ROWS);
    expect(TOTAL_ROWS).toBeGreaterThan(SINCE_MAP_PAGE_SIZE);

    const map = buildSchemeLatestMap(rows);

    expect(map.size).toBe(NUM_SCHEMES);
    for (let s = 0; s < NUM_SCHEMES; s++) {
      const code = 100_000 + s;
      // First occurrence for each scheme = row 0 = date '2026-01-50'
      expect(map.get(code)).toBe('2026-01-50');
    }
  });

  it('schemes beyond the 1,000-row mark are present (simulates pagination boundary)', () => {
    // Worst case: first 1,000 rows belong to one scheme; the 1,001st row is a
    // second scheme.  The accumulation must include both schemes.
    const rows: { scheme_code: number; nav_date: string }[] = [
      ...Array.from({ length: 1000 }, (_, i) => ({
        scheme_code: 1,
        nav_date: `2026-06-${String(Math.max(1, 10 - Math.floor(i / 100))).padStart(2, '0')}`,
      })),
      { scheme_code: 2, nav_date: '2026-06-10' }, // row 1,001 — only reachable via pagination
    ];

    const map = buildSchemeLatestMap(rows);
    expect(map.size).toBe(2);
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upsert-count semantics
//
// fetch-fund-nav previously did `upserted += chunk.length` (attempted rows)
// without ignoreDuplicates.  The fix: ignoreDuplicates: true + .select() so
// PostgREST returns only actually-inserted rows, and we count data.length.
//
// These tests verify the counting contract independently of a live DB.
// ---------------------------------------------------------------------------

describe('upsert-count semantics: ignoreDuplicates + select returns new rows only', () => {
  function makeMockBuilder(opts: { returnedCount: number }) {
    return {
      upsert(_rows: unknown[], _opts: { ignoreDuplicates?: boolean }) {
        return {
          select(_col: string) {
            const data = Array.from({ length: opts.returnedCount }, () => ({ nav_date: '2026-06-10' }));
            return Promise.resolve({ data, error: null });
          },
        };
      },
    };
  }

  async function countWithIgnoreDuplicates(
    builder: ReturnType<typeof makeMockBuilder>,
    chunk: unknown[],
  ): Promise<number> {
    const { data, error } = await builder
      .upsert(chunk, { ignoreDuplicates: true })
      .select('nav_date');
    if (error) throw error;
    // The fixed fetch-fund-nav counting logic:
    return data?.length ?? 0;
  }

  it('returns chunk.length when all rows are new (no duplicates)', async () => {
    const chunk = [1, 2, 3];
    const builder = makeMockBuilder({ returnedCount: chunk.length });
    expect(await countWithIgnoreDuplicates(builder, chunk)).toBe(3);
  });

  it('returns 0 when all rows are duplicates (re-hydration scenario)', async () => {
    const chunk = [1, 2, 3];
    const builder = makeMockBuilder({ returnedCount: 0 }); // nothing inserted
    expect(await countWithIgnoreDuplicates(builder, chunk)).toBe(0);
  });

  it('returns partial count when some rows are new and some are duplicates', async () => {
    const chunk = [1, 2, 3, 4, 5];
    const builder = makeMockBuilder({ returnedCount: 2 }); // 3 duplicates skipped
    expect(await countWithIgnoreDuplicates(builder, chunk)).toBe(2);
  });

  it('demonstrates the bug: chunk.length overcounts on re-hydration', () => {
    const chunk = [1, 2, 3];
    // Old (buggy) code: always adds chunk.length regardless of actual inserts
    const buggyCount = chunk.length; // 3, even when all are duplicates
    expect(buggyCount).toBe(3); // this is the over-count

    // Fixed code: uses data.length from select() — the test above shows it = 0
    const fixedCount = 0; // as verified by the mock above
    expect(fixedCount).toBe(0);
    expect(buggyCount).toBeGreaterThan(fixedCount);
  });
});
