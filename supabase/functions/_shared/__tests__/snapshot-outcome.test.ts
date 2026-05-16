import { summariseSnapshotOutcome } from '../snapshot-outcome';

describe('summariseSnapshotOutcome', () => {
  it('returns success when every result is OK', () => {
    expect(summariseSnapshotOutcome([
      { symbol: '^NSEITRI', ok: true },
      { symbol: '^NIFTY100TRI', ok: true },
      { symbol: '^NIFTY500TRI', ok: true },
    ])).toEqual({ outcome: 'success', failedSymbols: [] });
  });

  it('returns failure when every result failed (the load-bearing alert case)', () => {
    // This is the page-on-call signal: every snapshot stale across the
    // board until someone fixes the regen path.
    expect(summariseSnapshotOutcome([
      { symbol: '^NSEITRI', ok: false },
      { symbol: '^NIFTY100TRI', ok: false },
      { symbol: '^NIFTY500TRI', ok: false },
    ])).toEqual({
      outcome: 'failure',
      failedSymbols: ['^NSEITRI', '^NIFTY100TRI', '^NIFTY500TRI'],
    });
  });

  it('returns partial when some failed but not all', () => {
    expect(summariseSnapshotOutcome([
      { symbol: '^NSEITRI', ok: true },
      { symbol: '^NIFTY100TRI', ok: false },
      { symbol: '^NIFTY500TRI', ok: true },
    ])).toEqual({
      outcome: 'partial',
      failedSymbols: ['^NIFTY100TRI'],
    });
  });

  it('returns success on empty input (vacuously true; no symbols configured)', () => {
    // The function shouldn't surprise the caller; empty input means
    // there's nothing to fail.
    expect(summariseSnapshotOutcome([])).toEqual({ outcome: 'success', failedSymbols: [] });
  });

  it('preserves original symbol ordering in failedSymbols', () => {
    const result = summariseSnapshotOutcome([
      { symbol: '^Z', ok: false },
      { symbol: '^A', ok: false },
      { symbol: '^M', ok: true },
      { symbol: '^B', ok: false },
    ]);
    expect(result.failedSymbols).toEqual(['^Z', '^A', '^B']);
  });

  it('returns failure when single-symbol run fails', () => {
    expect(summariseSnapshotOutcome([
      { symbol: '^NSEITRI', ok: false },
    ])).toEqual({ outcome: 'failure', failedSymbols: ['^NSEITRI'] });
  });
});
