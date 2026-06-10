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
// Constants
// ---------------------------------------------------------------------------

describe('module constants', () => {
  it('MAX_ROWS_PER_RUN is 100 000', () => {
    expect(MAX_ROWS_PER_RUN).toBe(100_000);
  });

  it('NAV_RETENTION_DAYS is 90', () => {
    expect(NAV_RETENTION_DAYS).toBe(90);
  });

  it('SCHEME_DELETE_BATCH_SIZE is a positive integer', () => {
    expect(Number.isInteger(SCHEME_DELETE_BATCH_SIZE)).toBe(true);
    expect(SCHEME_DELETE_BATCH_SIZE).toBeGreaterThan(0);
  });
});
