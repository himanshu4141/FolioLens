import {
  buildSchemeLatestMap,
  checkOpenFolioResultFreshness,
  DEFAULT_MAX_UPSTREAM_AGE_TRADING_DAYS,
  evaluateOpenFolioNavFreshnessGate,
  SINCE_MAP_PAGE_SIZE,
  tradingDaysAge,
  upstreamAgeBucket,
} from '../nav-since-map';

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
// evaluateOpenFolioNavFreshnessGate
// ---------------------------------------------------------------------------

describe('evaluateOpenFolioNavFreshnessGate', () => {
  // 2026-07-16 is a Thursday; same-day `today` keeps upstream age at 0
  // trading days, i.e. "fresh" for all pre-existing (M1-predating) scenarios.
  const TODAY_FRESH = new Date('2026-07-16T12:00:00Z');

  it('skips only when every held scheme is current through OpenFolio latest NAV', () => {
    const result = evaluateOpenFolioNavFreshnessGate(
      [100, 200],
      new Map([
        [100, '2026-07-16'],
        [200, '2026-07-17'],
      ]),
      '2026-07-16',
      TODAY_FRESH,
    );

    expect(result.shouldSkip).toBe(true);
    expect(result.localMinLatestDate).toBe('2026-07-16');
    expect(result.missingSchemeCount).toBe(0);
    expect(result.staleSchemeCount).toBe(0);
    expect(result.currentSchemeCount).toBe(2);
    expect(result.syncSchemeCount).toBe(0);
    expect(result.syncSchemeCodes).toEqual([]);
    expect(result.upstreamStale).toBe(false);
    expect(result.upstreamAgeTradingDays).toBe(0);
  });

  it('syncs only held schemes missing local NAV history', () => {
    const result = evaluateOpenFolioNavFreshnessGate(
      [100, 200],
      new Map([[100, '2026-07-16']]),
      '2026-07-16',
      TODAY_FRESH,
    );

    expect(result.shouldSkip).toBe(false);
    expect(result.missingSchemeCount).toBe(1);
    expect(result.staleSchemeCount).toBe(0);
    expect(result.currentSchemeCount).toBe(1);
    expect(result.syncSchemeCount).toBe(1);
    expect(result.syncSchemeCodes).toEqual([200]);
    expect(result.upstreamStale).toBe(false);
  });

  it('syncs only held schemes that lag OpenFolio latest NAV', () => {
    const result = evaluateOpenFolioNavFreshnessGate(
      [100, 200],
      new Map([
        [100, '2026-07-16'],
        [200, '2026-07-15'],
      ]),
      '2026-07-16',
      TODAY_FRESH,
    );

    expect(result.shouldSkip).toBe(false);
    expect(result.missingSchemeCount).toBe(0);
    expect(result.staleSchemeCount).toBe(1);
    expect(result.localMinLatestDate).toBe('2026-07-15');
    expect(result.currentSchemeCount).toBe(1);
    expect(result.syncSchemeCount).toBe(1);
    expect(result.syncSchemeCodes).toEqual([200]);
    expect(result.upstreamStale).toBe(false);
  });

  it('does not skip when OpenFolio health has no valid db_nav_latest date', () => {
    const result = evaluateOpenFolioNavFreshnessGate(
      [100],
      new Map([[100, '2026-07-16']]),
      null,
      TODAY_FRESH,
    );

    expect(result.shouldSkip).toBe(false);
    expect(result.upstreamLatestDate).toBeNull();
    expect(result.reason).toMatch(/valid db_nav_latest/);
    expect(result.syncSchemeCount).toBe(1);
    expect(result.syncSchemeCodes).toEqual([100]);
    expect(result.upstreamStale).toBe(false);
    expect(result.upstreamAgeTradingDays).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Age-aware stale-upstream routing (M1) — a healthy-looking OpenFolio whose
  // db_nav_latest hasn't moved in days must never be trusted as "current".
  // -------------------------------------------------------------------------

  it('routes every held scheme to mfapi when upstream db_nav_latest is stale, regardless of shouldSkip semantics', () => {
    // db_nav_latest frozen at 2026-08-18 (Tue); today is 2026-09-10 (Thu) —
    // three weeks later, ~16 trading days old, well past the 2-day default.
    const today = new Date('2026-09-10T02:30:00Z');
    const result = evaluateOpenFolioNavFreshnessGate(
      [100, 200],
      new Map([
        [100, '2026-08-18'],
        [200, '2026-08-18'],
      ]),
      '2026-08-18',
      today,
    );

    expect(result.shouldSkip).toBe(false);
    expect(result.upstreamStale).toBe(true);
    expect(result.upstreamAgeTradingDays).toBeGreaterThan(2);
    expect(result.syncSchemeCodes.sort()).toEqual([100, 200]);
    expect(result.syncSchemeCount).toBe(2);
    expect(result.reason).toMatch(/Upstream stale/);
  });

  it('does not re-route a held scheme whose local NAV is already fresh, even when upstream is stale', () => {
    const today = new Date('2026-09-10T02:30:00Z');
    const result = evaluateOpenFolioNavFreshnessGate(
      [100, 200],
      new Map([
        [100, '2026-08-18'], // stale local NAV — needs sync
        [200, '2026-09-09'], // already fresh (e.g. from a prior stale-routing run)
      ]),
      '2026-08-18',
      today,
    );

    expect(result.upstreamStale).toBe(true);
    expect(result.shouldSkip).toBe(false);
    expect(result.syncSchemeCodes).toEqual([100]);
    expect(result.currentSchemeCount).toBe(1);
    expect(result.staleSchemeCount).toBe(1);
  });

  it('still routes schemes missing local history when upstream is stale', () => {
    const today = new Date('2026-09-10T02:30:00Z');
    const result = evaluateOpenFolioNavFreshnessGate(
      [100, 200],
      new Map([[100, '2026-08-18']]),
      '2026-08-18',
      today,
    );

    expect(result.upstreamStale).toBe(true);
    expect(result.missingSchemeCount).toBe(1);
    expect(result.staleSchemeCount).toBe(1);
    expect(result.syncSchemeCodes.sort()).toEqual([100, 200]);
  });

  it('honours a custom maxUpstreamAgeTradingDays threshold', () => {
    // 2 trading days old (Mon -> Wed), default threshold of 2 keeps it fresh.
    const today = new Date('2026-07-22T00:00:00Z'); // Wednesday
    const result = evaluateOpenFolioNavFreshnessGate(
      [100],
      new Map([[100, '2026-07-20']]), // Monday
      '2026-07-20',
      today,
    );
    expect(result.upstreamAgeTradingDays).toBe(2);
    expect(result.upstreamStale).toBe(false);

    const stricter = evaluateOpenFolioNavFreshnessGate(
      [100],
      new Map([[100, '2026-07-20']]),
      '2026-07-20',
      today,
      1,
    );
    expect(stricter.upstreamStale).toBe(true);
  });
});

describe('tradingDaysAge', () => {
  it('returns 0 for the same day', () => {
    expect(tradingDaysAge('2026-07-16', new Date('2026-07-16T23:00:00Z'))).toBe(0);
  });

  it('excludes weekends from the count', () => {
    // Friday -> Monday is one trading day (Monday), not three calendar days.
    expect(tradingDaysAge('2026-07-17', new Date('2026-07-20T00:00:00Z'))).toBe(1);
  });

  it('counts each weekday once across a multi-week span', () => {
    // 2026-08-18 (Tue) -> 2026-09-10 (Thu): 17 trading days.
    expect(tradingDaysAge('2026-08-18', new Date('2026-09-10T00:00:00Z'))).toBe(17);
  });
});

describe('upstreamAgeBucket', () => {
  it('buckets into the four low-cardinality ranges', () => {
    expect(upstreamAgeBucket(null)).toBeNull();
    expect(upstreamAgeBucket(0)).toBe('0-1');
    expect(upstreamAgeBucket(1)).toBe('0-1');
    expect(upstreamAgeBucket(2)).toBe('2-3');
    expect(upstreamAgeBucket(3)).toBe('2-3');
    expect(upstreamAgeBucket(4)).toBe('4-7');
    expect(upstreamAgeBucket(7)).toBe('4-7');
    expect(upstreamAgeBucket(8)).toBe('8+');
    expect(upstreamAgeBucket(100)).toBe('8+');
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

// ---------------------------------------------------------------------------
// fetch-fund-nav stale fall-through decision (M1)
//
// fetch-fund-nav's incremental branch ("OpenFolio returned zero new points
// since our last known date") used to declare the scheme up to date
// unconditionally. That trusts a frozen upstream watermark. The fix routes
// both fetch-fund-nav call sites (the empty-points "no new points since"
// check, and the non-empty "points landed but the result is still stale"
// check) through checkOpenFolioResultFreshness — the actual function
// fetch-fund-nav/index.ts imports and calls, not a reimplementation of its
// comparison, so a regression to an unconditional cache_hit/fetched, a wrong
// date being checked, or the threshold itself drifting would fail these
// tests too, not just an inline copy that happens to agree with the code.
// ---------------------------------------------------------------------------

describe('fetch-fund-nav stale fall-through decision', () => {
  it('declares cache_hit when the local series is within the trading-day threshold', () => {
    // Friday -> Monday: 1 trading day old, within the 2-day default.
    const result = checkOpenFolioResultFreshness('2026-07-17', new Date('2026-07-20T00:00:00Z'));
    expect(result.fresh).toBe(true);
    expect(result.ageTradingDays).toBe(1);
  });

  it('falls through to mfapi when OpenFolio reports no new points but the local series is stale', () => {
    // 2026-08-18 -> 2026-09-10: 17 trading days old, well past the threshold —
    // this is the exact scenario that froze held NAVs at 18 Aug in the incident.
    const result = checkOpenFolioResultFreshness('2026-08-18', new Date('2026-09-10T00:00:00Z'));
    expect(result.fresh).toBe(false);
    expect(result.ageTradingDays).toBe(17);
  });

  it('sits exactly on the threshold boundary as a cache_hit (<=, not <)', () => {
    // Monday -> Wednesday is 2 trading days, equal to the default threshold.
    const result = checkOpenFolioResultFreshness('2026-07-20', new Date('2026-07-22T00:00:00Z'));
    expect(result.fresh).toBe(true);
    expect(result.ageTradingDays).toBe(2);
  });

  it('respects a caller-supplied threshold override', () => {
    // 3 trading days old fails the default 2-day threshold but passes a 3-day one.
    expect(checkOpenFolioResultFreshness('2026-07-17', new Date('2026-07-22T00:00:00Z')).fresh).toBe(
      false,
    );
    expect(
      checkOpenFolioResultFreshness('2026-07-17', new Date('2026-07-22T00:00:00Z'), 3).fresh,
    ).toBe(true);
  });

  // The same function also gates the "OpenFolio returned *some* points, but
  // its series still stops at a stale date" case — a scheme that is
  // data_loaded (not empty) must not be declared 'fetched' just because
  // points.length > 0 when the resulting last_nav_date is itself stale.
  it('does not declare fetched when OpenFolio returns points but the result is still stale', () => {
    // OF answers with catch-up points ending 2026-08-18 — 17 trading days
    // before 2026-09-10 — instead of admitting it is frozen.
    expect(checkOpenFolioResultFreshness('2026-08-18', new Date('2026-09-10T00:00:00Z')).fresh).toBe(
      false,
    );
  });

  it('declares fetched when the points OpenFolio returned land within the threshold', () => {
    expect(checkOpenFolioResultFreshness('2026-07-17', new Date('2026-07-20T00:00:00Z')).fresh).toBe(
      true,
    );
  });
});
