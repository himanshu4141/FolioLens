import { shouldRebuildTxOnDrift } from '../sync';

describe('shouldRebuildTxOnDrift', () => {
  describe('does NOT rebuild on small drifts (sync race window)', () => {
    it('returns false when counts match exactly', () => {
      expect(shouldRebuildTxOnDrift(100, 100)).toBe(false);
    });

    it('returns false when drift is 1 row (typical race: row arrived between local + server count)', () => {
      expect(shouldRebuildTxOnDrift(100, 101)).toBe(false);
      expect(shouldRebuildTxOnDrift(101, 100)).toBe(false);
    });

    it('returns false at the absolute boundary (drift = 4, just under threshold)', () => {
      expect(shouldRebuildTxOnDrift(100, 104)).toBe(false);
    });

    it('returns false when relative drift is exactly 5% (not strictly above)', () => {
      // 100 local, 105 server → drift 5, drift_pct = 5/105 ≈ 4.76% → false
      expect(shouldRebuildTxOnDrift(100, 105)).toBe(false);
    });

    it('returns false for a 100-row portfolio missing 1 row (1% drift)', () => {
      expect(shouldRebuildTxOnDrift(99, 100)).toBe(false);
    });
  });

  describe('rebuilds on meaningful drift (the load-bearing case)', () => {
    it('returns true on the May 2026 user scenario: ~25% portfolio rows missing', () => {
      // User had ~800 local rows but server had ~1100 — Portfolio
      // showed ₹23L instead of ₹31L. Reconciliation should fire here.
      expect(shouldRebuildTxOnDrift(800, 1100)).toBe(true);
    });

    it('returns true when local cache has zero but server has many (post-clear edge)', () => {
      // Shouldn't happen in normal flow (a zero local would be a
      // fresh bootstrap that fetches all), but if it does, rebuild.
      expect(shouldRebuildTxOnDrift(0, 1000)).toBe(true);
    });

    it('returns true when server has fewer (server-side cleanup like account deletion)', () => {
      expect(shouldRebuildTxOnDrift(1100, 800)).toBe(true);
    });

    it('rebuilds on a 30-row portfolio missing 6 rows (20%)', () => {
      expect(shouldRebuildTxOnDrift(24, 30)).toBe(true);
    });
  });

  describe('boundary tests at the dual-threshold corners', () => {
    it('drift=5 exactly + relative > 5% → rebuild fires', () => {
      // 4 local, 9 server → drift 5, drift_pct ≈ 55.5% → rebuild
      expect(shouldRebuildTxOnDrift(4, 9)).toBe(true);
    });

    it('drift=5 exactly + relative just under 5% → no rebuild', () => {
      // 100 local, 105 server → drift 5, drift_pct ≈ 4.76% → no rebuild
      expect(shouldRebuildTxOnDrift(100, 105)).toBe(false);
    });

    it('drift=4 + relative very high → no rebuild (absolute floor protects against tiny portfolios)', () => {
      // 1 local, 5 server → drift 4, drift_pct = 80% but still no rebuild
      // (single-digit portfolios are noisy; force user to do something
      // explicit if a manual import didn't land)
      expect(shouldRebuildTxOnDrift(1, 5)).toBe(false);
    });
  });

  describe('zero server count', () => {
    it('returns false when both are zero', () => {
      expect(shouldRebuildTxOnDrift(0, 0)).toBe(false);
    });

    it('returns false when server is zero but local has fewer than 5 rows (orphan but small)', () => {
      // 4 local, 0 server → drift 4, below absolute threshold → no rebuild
      expect(shouldRebuildTxOnDrift(4, 0)).toBe(false);
    });

    it('returns false when server is zero — drift_pct is 0 because the denominator is 0', () => {
      // Without this guard, dividing by zero would produce NaN; the
      // function should return false (we have nothing to reconcile against).
      expect(shouldRebuildTxOnDrift(1000, 0)).toBe(false);
    });
  });
});
