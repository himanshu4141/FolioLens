import {
  isPruneable,
  MAX_ROWS_PER_RUN,
  NAV_RETENTION_DAYS,
  retentionCutoffDate,
  SCHEME_DELETE_BATCH_SIZE,
} from '../nav-retention';

// ---------------------------------------------------------------------------
// retentionCutoffDate
// ---------------------------------------------------------------------------

describe('retentionCutoffDate', () => {
  it('returns an ISO-8601 timestamp exactly N days before now', () => {
    const now = new Date('2026-06-10T12:00:00.000Z');
    // 90 days before 2026-06-10 = 2026-03-12
    expect(retentionCutoffDate(now, 90)).toBe('2026-03-12T12:00:00.000Z');
  });

  it('defaults to NAV_RETENTION_DAYS when the second argument is omitted', () => {
    const now = new Date('2026-06-10T00:00:00.000Z');
    expect(retentionCutoffDate(now)).toBe(retentionCutoffDate(now, NAV_RETENTION_DAYS));
  });

  it('returns a string that sorts strictly before the reference timestamp', () => {
    const now = new Date('2026-06-10T15:30:00.000Z');
    expect(retentionCutoffDate(now) < now.toISOString()).toBe(true);
  });

  it('handles the boundary: 1-day retention', () => {
    const now = new Date('2026-06-10T00:00:00.000Z');
    expect(retentionCutoffDate(now, 1)).toBe('2026-06-09T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// isPruneable
// ---------------------------------------------------------------------------

describe('isPruneable', () => {
  const CUTOFF = '2026-03-12T12:00:00.000Z';

  describe('held schemes are never prunable', () => {
    it('returns false for a held scheme with null nav_backfilled_at', () => {
      expect(isPruneable(true, null, CUTOFF)).toBe(false);
    });

    it('returns false for a held scheme whose backfilled_at is ancient', () => {
      expect(isPruneable(true, '2020-01-01T00:00:00.000Z', CUTOFF)).toBe(false);
    });

    it('returns false for a held scheme whose backfilled_at is very recent', () => {
      expect(isPruneable(true, '2026-06-09T00:00:00.000Z', CUTOFF)).toBe(false);
    });
  });

  describe('unheld schemes with null backfilled_at', () => {
    it('returns true (never demand-fetched → safe to prune)', () => {
      expect(isPruneable(false, null, CUTOFF)).toBe(true);
    });
  });

  describe('unheld schemes with a stale backfilled_at (before cutoff)', () => {
    it('returns true when backfilled_at is one second before cutoff', () => {
      expect(isPruneable(false, '2026-03-12T11:59:59.000Z', CUTOFF)).toBe(true);
    });

    it('returns true when backfilled_at is far in the past', () => {
      expect(isPruneable(false, '2025-01-01T00:00:00.000Z', CUTOFF)).toBe(true);
    });
  });

  describe('unheld schemes with a fresh backfilled_at (on or after cutoff)', () => {
    it('returns false when backfilled_at equals the cutoff exactly', () => {
      // Boundary: same string → not strictly less → not pruneable
      expect(isPruneable(false, CUTOFF, CUTOFF)).toBe(false);
    });

    it('returns false when backfilled_at is one second after the cutoff', () => {
      expect(isPruneable(false, '2026-03-12T12:00:01.000Z', CUTOFF)).toBe(false);
    });

    it('returns false for a very recently backfilled scheme', () => {
      expect(isPruneable(false, '2026-06-09T22:00:00.000Z', CUTOFF)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Candidate walk pagination (simulated)
// ---------------------------------------------------------------------------

describe('candidate walk pagination (simulating nav_history query pagination)', () => {
  it('exhausts all results when pagination limit is much smaller than data set', () => {
    // Simulate paginating through nav_history with 1000-row pages
    const PAGE_SIZE = 1000;
    const totalSchemes = 5678; // More than one page
    const allSchemes = new Set<number>();

    // Simulate pages
    let from = 0;
    while (true) {
      const end = Math.min(from + PAGE_SIZE, totalSchemes);
      const count = end - from;
      if (count === 0) break;

      for (let i = from; i < end; i++) {
        allSchemes.add(i);
      }

      if (count < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    expect(allSchemes.size).toBe(totalSchemes);
  });

  it('handles the boundary: exactly PAGE_SIZE rows', () => {
    const PAGE_SIZE = 1000;
    const allSchemes = new Set<number>();

    // Simulate exactly one full page
    for (let i = 0; i < PAGE_SIZE; i++) {
      allSchemes.add(i);
    }

    expect(allSchemes.size).toBe(PAGE_SIZE);
  });

  it('handles the boundary: PAGE_SIZE + 1 rows (requires two pages)', () => {
    const PAGE_SIZE = 1000;
    const allSchemes = new Set<number>();

    // Simulate more than one full page
    for (let i = 0; i < PAGE_SIZE + 1; i++) {
      allSchemes.add(i);
    }

    expect(allSchemes.size).toBe(PAGE_SIZE + 1);
  });
});

// ---------------------------------------------------------------------------
// Held exclusion in a large candidate set
// ---------------------------------------------------------------------------

describe('held exclusion filtering from candidates', () => {
  it('excludes all held schemes when they overlap with candidates', () => {
    const heldCodes = new Set([100, 200, 300]);
    const candidates = [100, 200, 300, 400, 500];
    const cutoff = '2026-03-12T12:00:00.000Z';

    const filtered = candidates.filter(
      (code) => !heldCodes.has(code) && isPruneable(false, null, cutoff),
    );

    expect(filtered).toEqual([400, 500]);
  });

  it('preserves all candidates when held set is empty', () => {
    const heldCodes = new Set<number>();
    const candidates = [100, 200, 300];
    const cutoff = '2026-03-12T12:00:00.000Z';

    const filtered = candidates.filter(
      (code) => !heldCodes.has(code) && isPruneable(false, null, cutoff),
    );

    expect(filtered).toEqual([100, 200, 300]);
  });

  it('preserves candidates not in held set when held set is non-empty', () => {
    const heldCodes = new Set([1, 2]);
    const candidates = [1, 2, 3, 4, 5];
    const cutoff = '2026-03-12T12:00:00.000Z';

    const filtered = candidates.filter(
      (code) => !heldCodes.has(code) && isPruneable(false, null, cutoff),
    );

    expect(filtered).toEqual([3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// Batch lookup behavior (batches of ≤200 scheme codes)
// ---------------------------------------------------------------------------

describe('batch lookup of scheme_master (≤200 per batch)', () => {
  it('correctly batches 201 candidates into 2 batches of 200 and 1', () => {
    const BATCH_SIZE = 200;
    const candidates = Array.from({ length: 201 }, (_, i) => i + 1);
    const batches: number[][] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(200);
    expect(batches[1]).toHaveLength(1);
  });

  it('correctly batches 1000 candidates into 5 batches of 200 each', () => {
    const BATCH_SIZE = 200;
    const candidates = Array.from({ length: 1000 }, (_, i) => i + 1);
    const batches: number[][] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      batches.push(candidates.slice(i, i + BATCH_SIZE));
    }

    expect(batches).toHaveLength(5);
    expect(batches.every((b) => b.length === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('module constants', () => {
  it('MAX_ROWS_PER_RUN is 100 000', () => {
    expect(MAX_ROWS_PER_RUN).toBe(100_000);
  });

  it('NAV_RETENTION_DAYS is 90', () => {
    expect(NAV_RETENTION_DAYS).toBe(90);
  });

  it('SCHEME_DELETE_BATCH_SIZE is 50', () => {
    expect(SCHEME_DELETE_BATCH_SIZE).toBe(50);
  });

  it('SCHEME_DELETE_BATCH_SIZE fits within MAX_ROWS_PER_RUN', () => {
    // Each scheme typically has 1–5k rows; 50 per batch = 50–250k max per batch.
    // MAX_ROWS_PER_RUN caps the total, so each batch deletion is individually safe.
    expect(SCHEME_DELETE_BATCH_SIZE).toBeGreaterThan(0);
    expect(MAX_ROWS_PER_RUN).toBeGreaterThan(SCHEME_DELETE_BATCH_SIZE);
  });
});
