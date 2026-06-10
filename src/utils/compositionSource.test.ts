import {
  COMPOSITION_SOURCE_RANK,
  compositionSourceRank,
  isBetterCompositionSource,
  pickBestCompositionRows,
} from './compositionSource';

describe('compositionSourceRank', () => {
  it('orders official > amfi > category_fallback > category_rules', () => {
    expect(COMPOSITION_SOURCE_RANK.official).toBe(3);
    expect(compositionSourceRank('official')).toBeGreaterThan(compositionSourceRank('amfi'));
    expect(compositionSourceRank('amfi')).toBeGreaterThan(compositionSourceRank('category_fallback'));
    expect(compositionSourceRank('category_fallback')).toBeGreaterThan(compositionSourceRank('category_rules'));
  });

  it('ranks unknown / null / undefined below every known source', () => {
    expect(compositionSourceRank('mfdata')).toBe(-1);
    expect(compositionSourceRank(null)).toBe(-1);
    expect(compositionSourceRank(undefined)).toBe(-1);
  });
});

describe('isBetterCompositionSource', () => {
  it('is true only when a strictly outranks b', () => {
    expect(isBetterCompositionSource('official', 'amfi')).toBe(true);
    expect(isBetterCompositionSource('amfi', 'official')).toBe(false);
    expect(isBetterCompositionSource('amfi', 'amfi')).toBe(false);
    expect(isBetterCompositionSource('amfi', null)).toBe(true);
  });
});

describe('pickBestCompositionRows', () => {
  const row = (scheme_code: number, source: string | null, portfolio_date: string) => ({
    scheme_code,
    source,
    portfolio_date,
  });

  it('picks the highest-precedence source per scheme regardless of input order', () => {
    const result = pickBestCompositionRows([
      row(1, 'category_rules', '2026-05-01'),
      row(1, 'amfi', '2026-04-30'),
      row(1, 'official', '2026-04-30'),
      row(1, 'category_fallback', '2026-04-30'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('official');
  });

  it('does NOT regress to alphabetical ordering (official must beat amfi)', () => {
    // 'official' sorts AFTER 'amfi' alphabetically — the old ASC sort would
    // have wrongly kept amfi. Precedence must override.
    const result = pickBestCompositionRows([row(1, 'amfi', '2026-04-30'), row(1, 'official', '2026-04-30')]);
    expect(result[0].source).toBe('official');
  });

  it('breaks ties on the same source by most recent portfolio_date', () => {
    const result = pickBestCompositionRows([
      row(1, 'official', '2026-03-31'),
      row(1, 'official', '2026-04-30'),
    ]);
    expect(result[0].portfolio_date).toBe('2026-04-30');
    // older date must not displace the newer one
    const reordered = pickBestCompositionRows([
      row(1, 'official', '2026-04-30'),
      row(1, 'official', '2026-03-31'),
    ]);
    expect(reordered[0].portfolio_date).toBe('2026-04-30');
  });

  it('keeps one best row per distinct scheme_code', () => {
    const result = pickBestCompositionRows([
      row(1, 'amfi', '2026-04-30'),
      row(2, 'category_rules', '2026-05-01'),
      row(2, 'official', '2026-04-30'),
    ]);
    const bySch = Object.fromEntries(result.map((r) => [r.scheme_code, r.source]));
    expect(result).toHaveLength(2);
    expect(bySch[1]).toBe('amfi');
    expect(bySch[2]).toBe('official');
  });

  it('returns an empty array for empty input', () => {
    expect(pickBestCompositionRows([])).toEqual([]);
  });

  it('sentinel date 1900-01-01 on category_rules never beats a higher-ranked source', () => {
    // category_rules rows use '1900-01-01' as portfolio_date (sentinel) to
    // prevent per-day accretion. Confirm the sentinel can't displace real data.
    const result = pickBestCompositionRows([
      row(1, 'category_rules', '1900-01-01'),
      row(1, 'amfi', '2026-04-30'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('amfi');
    expect(result[0].portfolio_date).toBe('2026-04-30');
  });

  it('sentinel date does not affect tie-break between two different schemes', () => {
    const result = pickBestCompositionRows([
      row(1, 'category_rules', '1900-01-01'),
      row(2, 'official', '2026-04-30'),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.scheme_code === 1)?.source).toBe('category_rules');
    expect(result.find((r) => r.scheme_code === 2)?.source).toBe('official');
  });
});
