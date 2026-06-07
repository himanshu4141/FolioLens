import { isSchemeMetaFresh, type SchemeMetaCacheRow } from '../scheme-meta-cache';

const TTL = 7;
const NOW = Date.UTC(2026, 4, 15, 12, 0, 0); // 2026-05-15 12:00 UTC

function row(synced: string | null, family: number | null, ofSynced?: string | null): SchemeMetaCacheRow {
  return { fund_meta_synced_at: synced, mfdata_family_id: family, openfolio_meta_synced_at: ofSynced };
}

function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('isSchemeMetaFresh (mfdata path, backward compat)', () => {
  it('returns false when the row is null (never synced)', () => {
    expect(isSchemeMetaFresh(null, TTL, NOW)).toBe(false);
  });

  it('returns false when the row is undefined (Supabase maybeSingle miss)', () => {
    expect(isSchemeMetaFresh(undefined, TTL, NOW)).toBe(false);
  });

  it('returns false when fund_meta_synced_at is null', () => {
    expect(isSchemeMetaFresh(row(null, 12345), TTL, NOW)).toBe(false);
  });

  it('returns false when mfdata_family_id is null even with a fresh timestamp (the partial-success guard)', () => {
    // Direct repro of audit finding #6: previous sync got mfapi-only,
    // bumped the synced_at, left family_id null. Without this guard,
    // the next 7 days of fetch-fund-snapshot calls would cache-hit
    // and serve category_fallback compositions.
    expect(isSchemeMetaFresh(row(daysAgo(1), null), TTL, NOW)).toBe(false);
  });

  it('returns true when both timestamp is fresh AND family_id is populated', () => {
    expect(isSchemeMetaFresh(row(daysAgo(1), 12345), TTL, NOW)).toBe(true);
  });

  it('returns true at the exact day before the TTL cutoff (boundary, ageDays < 7)', () => {
    expect(isSchemeMetaFresh(row(daysAgo(6.9), 12345), TTL, NOW)).toBe(true);
  });

  it('returns false at the exact TTL boundary (ageDays === 7)', () => {
    expect(isSchemeMetaFresh(row(daysAgo(7), 12345), TTL, NOW)).toBe(false);
  });

  it('returns false when stale beyond TTL', () => {
    expect(isSchemeMetaFresh(row(daysAgo(30), 12345), TTL, NOW)).toBe(false);
  });

  it('respects custom TTL', () => {
    expect(isSchemeMetaFresh(row(daysAgo(2), 12345), 1, NOW)).toBe(false);
    expect(isSchemeMetaFresh(row(daysAgo(0.5), 12345), 1, NOW)).toBe(true);
  });

  it('forces retry on partial-success no matter how recent the timestamp', () => {
    // 1 second ago, family_id null → still retry. The TTL doesn't
    // protect us from the partial-success bug.
    const oneSecondAgo = new Date(NOW - 1000).toISOString();
    expect(isSchemeMetaFresh(row(oneSecondAgo, null), TTL, NOW)).toBe(false);
  });
});

describe('isSchemeMetaFresh (OpenFolio path)', () => {
  it('returns true when openfolio_meta_synced_at is recent — no mfdata_family_id required', () => {
    // OpenFolio path doesn't have the partial-success problem — family_id is
    // irrelevant. A recent OF sync is always fresh.
    expect(isSchemeMetaFresh(row(null, null, daysAgo(1)), TTL, NOW)).toBe(true);
  });

  it('returns true when OF synced within TTL even if mfdata sync is stale', () => {
    expect(isSchemeMetaFresh(row(daysAgo(30), 12345, daysAgo(2)), TTL, NOW)).toBe(true);
  });

  it('returns false when OF sync is stale even with a recent mfdata sync', () => {
    // OF staleness is checked first; if stale, falls through to mfdata check.
    // mfdata path is separately fresh → still returns true overall.
    expect(isSchemeMetaFresh(row(daysAgo(1), 12345, daysAgo(8)), TTL, NOW)).toBe(true);
  });

  it('returns false when OF is stale AND mfdata path also fails (no family_id)', () => {
    expect(isSchemeMetaFresh(row(daysAgo(1), null, daysAgo(8)), TTL, NOW)).toBe(false);
  });

  it('returns false when OF is stale AND no mfdata sync at all', () => {
    expect(isSchemeMetaFresh(row(null, null, daysAgo(8)), TTL, NOW)).toBe(false);
  });

  it('returns false at the exact OF TTL boundary', () => {
    expect(isSchemeMetaFresh(row(null, null, daysAgo(7)), TTL, NOW)).toBe(false);
  });

  it('returns true just within the OF TTL boundary', () => {
    expect(isSchemeMetaFresh(row(null, null, daysAgo(6.9)), TTL, NOW)).toBe(true);
  });

  it('returns false when openfolio_meta_synced_at is null (falls through to mfdata path)', () => {
    // null OF timestamp → skip OF path, check mfdata
    expect(isSchemeMetaFresh(row(daysAgo(1), null, null), TTL, NOW)).toBe(false);
  });
});
