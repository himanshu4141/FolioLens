import { mergeMfdataReturns, mergeOfReturns } from '../period-returns';

// ---------------------------------------------------------------------------
// mergeMfdataReturns — conversion
// ---------------------------------------------------------------------------

describe('mergeMfdataReturns — conversion (12.5 percent → 0.125 decimal)', () => {
  it('converts return_1y 12.5 → ret_1y 0.125', () => {
    const result = mergeMfdataReturns({ return_1y: 12.5 }, null);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).ret_1y).toBeCloseTo(0.125);
  });

  it('converts return_3y 15.0 → ret_3y 0.15', () => {
    const result = mergeMfdataReturns({ return_3y: 15.0 }, null);
    expect((result as Record<string, unknown>).ret_3y).toBeCloseTo(0.15);
  });

  it('converts return_5y 9.29 → ret_5y 0.0929', () => {
    const result = mergeMfdataReturns({ return_5y: 9.29 }, null);
    expect((result as Record<string, unknown>).ret_5y).toBeCloseTo(0.0929);
  });

  it('converts return_inception to ret_incep', () => {
    const result = mergeMfdataReturns({ return_inception: 18.0 }, null);
    expect((result as Record<string, unknown>).ret_incep).toBeCloseTo(0.18);
  });

  it('converts short-horizon returns: 1m, 3m, 6m', () => {
    const result = mergeMfdataReturns(
      { return_1m: 2.5, return_3m: 5.1, return_6m: 8.2 },
      null,
    ) as Record<string, unknown>;
    expect(result.ret_1m).toBeCloseTo(0.025);
    expect(result.ret_3m).toBeCloseTo(0.051);
    expect(result.ret_6m).toBeCloseTo(0.082);
  });

  it('converts negative returns correctly', () => {
    const result = mergeMfdataReturns({ return_1y: -5.0 }, null);
    expect((result as Record<string, unknown>).ret_1y).toBeCloseTo(-0.05);
  });

  it('converts zero return correctly', () => {
    const result = mergeMfdataReturns({ return_1y: 0 }, null);
    expect((result as Record<string, unknown>).ret_1y).toBeCloseTo(0);
  });

  it('does NOT keep the old return_* key — only the canonical ret_* key', () => {
    const result = mergeMfdataReturns({ return_1y: 12.5 }, null) as Record<string, unknown>;
    expect(result.return_1y).toBeUndefined();
    expect(result.ret_1y).toBeCloseTo(0.125);
  });
});

// ---------------------------------------------------------------------------
// mergeMfdataReturns — passthrough keys (ranks, as_of_date)
// ---------------------------------------------------------------------------

describe('mergeMfdataReturns — passthrough keys', () => {
  it('passes rank_1y, rank_3y, rank_5y through unchanged', () => {
    const result = mergeMfdataReturns(
      { rank_1y: 7, rank_3y: 3, rank_5y: 5 },
      null,
    ) as Record<string, unknown>;
    expect(result.rank_1y).toBe(7);
    expect(result.rank_3y).toBe(3);
    expect(result.rank_5y).toBe(5);
  });

  it('passes rank_1m, rank_3m, rank_6m through unchanged', () => {
    const result = mergeMfdataReturns(
      { rank_1m: 1, rank_3m: 2, rank_6m: 4 },
      null,
    ) as Record<string, unknown>;
    expect(result.rank_1m).toBe(1);
    expect(result.rank_3m).toBe(2);
    expect(result.rank_6m).toBe(4);
  });

  it('passes as_of_date through unchanged', () => {
    const result = mergeMfdataReturns(
      { as_of_date: '2026-05-31' },
      null,
    ) as Record<string, unknown>;
    expect(result.as_of_date).toBe('2026-05-31');
  });
});

// ---------------------------------------------------------------------------
// mergeMfdataReturns — null / absent field handling
// ---------------------------------------------------------------------------

describe('mergeMfdataReturns — null/absent fields', () => {
  it('returns null when both inputs are null', () => {
    expect(mergeMfdataReturns(null, null)).toBeNull();
  });

  it('returns null when both inputs are undefined', () => {
    expect(mergeMfdataReturns(undefined, undefined)).toBeNull();
  });

  it('returns null for empty mfdataReturns and no existing blob', () => {
    expect(mergeMfdataReturns({}, null)).toBeNull();
  });

  it('skips non-finite values (NaN, Infinity)', () => {
    const result = mergeMfdataReturns({ return_1y: NaN, return_3y: Infinity }, null);
    expect(result).toBeNull();
  });

  it('skips absent return fields gracefully', () => {
    const result = mergeMfdataReturns({ return_1y: 12.5 }, null) as Record<string, unknown>;
    expect(result.ret_3y).toBeUndefined();
    expect(result.ret_5y).toBeUndefined();
  });

  it('returns existing blob values even when mfdataReturns is null', () => {
    const result = mergeMfdataReturns(null, { ret_1y: 0.20 }) as Record<string, unknown>;
    expect(result.ret_1y).toBeCloseTo(0.20);
  });
});

// ---------------------------------------------------------------------------
// mergeMfdataReturns — merge semantics (existing wins)
// ---------------------------------------------------------------------------

describe('mergeMfdataReturns — merge semantics', () => {
  it('existing blob wins for overlapping keys (preserves OF ret_1y)', () => {
    const result = mergeMfdataReturns(
      { return_1y: 12.5 },       // mfdata: would give ret_1y=0.125
      { ret_1y: 0.20 },          // existing OF value: must win
    ) as Record<string, unknown>;
    expect(result.ret_1y).toBeCloseTo(0.20);
  });

  it('mfdata fills new horizons without overwriting existing', () => {
    const result = mergeMfdataReturns(
      { return_1m: 2.5, return_3m: 5.1, return_1y: 12.5 },
      { ret_1y: 0.20, ret_3y: 0.15 },          // OF already has 1y and 3y
    ) as Record<string, unknown>;
    expect(result.ret_1y).toBeCloseTo(0.20);    // existing OF wins
    expect(result.ret_3y).toBeCloseTo(0.15);    // existing OF preserved
    expect(result.ret_1m).toBeCloseTo(0.025);   // mfdata 1m added ✓
    expect(result.ret_3m).toBeCloseTo(0.051);   // mfdata 3m added ✓
  });

  it('mfdata ranks are added even when ret_ fields from OF exist', () => {
    const result = mergeMfdataReturns(
      { return_1y: 12.5, rank_1y: 3, as_of_date: '2026-05-31' },
      { ret_1y: 0.20 },
    ) as Record<string, unknown>;
    expect(result.ret_1y).toBeCloseTo(0.20);       // existing wins
    expect(result.rank_1y).toBe(3);                // rank added ✓
    expect(result.as_of_date).toBe('2026-05-31');  // date added ✓
  });

  it('full mfdata blob merged with empty existing', () => {
    const mfdata = {
      return_1m: 2.5, return_3m: 5.1, return_6m: 8.2,
      return_1y: 12.5, return_3y: 15.0, return_5y: 9.29,
      return_inception: 18.0,
      rank_1y: 7, rank_3y: 3, rank_5y: 5,
      as_of_date: '2026-05-31',
    };
    const result = mergeMfdataReturns(mfdata, {}) as Record<string, unknown>;
    expect(result.ret_1m).toBeCloseTo(0.025);
    expect(result.ret_3m).toBeCloseTo(0.051);
    expect(result.ret_6m).toBeCloseTo(0.082);
    expect(result.ret_1y).toBeCloseTo(0.125);
    expect(result.ret_3y).toBeCloseTo(0.15);
    expect(result.ret_5y).toBeCloseTo(0.0929);
    expect(result.ret_incep).toBeCloseTo(0.18);
    expect(result.rank_1y).toBe(7);
    expect(result.rank_3y).toBe(3);
    expect(result.rank_5y).toBe(5);
    expect(result.as_of_date).toBe('2026-05-31');
    // Old percent-format keys must not be written
    expect(result.return_1y).toBeUndefined();
    expect(result.return_3y).toBeUndefined();
    expect(result.return_inception).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeOfReturns
// ---------------------------------------------------------------------------

describe('mergeOfReturns', () => {
  it('writes OF ret_1y into an empty blob', () => {
    const result = mergeOfReturns({ ret_1y: 0.125 }, null);
    expect(result.ret_1y).toBeCloseTo(0.125);
  });

  it('OF values win for overlapping keys', () => {
    const result = mergeOfReturns(
      { ret_1y: 0.125 },          // new OF value
      { ret_1y: 0.20 },           // stale existing value
    );
    expect(result.ret_1y).toBeCloseTo(0.125);  // OF wins
  });

  it('preserves mfdata extra horizons from existing blob', () => {
    const result = mergeOfReturns(
      { ret_1y: 0.125, ret_3y: 0.15 },
      { ret_1m: 0.025, rank_1y: 7, as_of_date: '2026-05-31' },
    );
    expect(result.ret_1y).toBeCloseTo(0.125);
    expect(result.ret_3y).toBeCloseTo(0.15);
    expect(result.ret_1m).toBeCloseTo(0.025);   // mfdata preserved ✓
    expect(result.rank_1y).toBe(7);             // rank preserved ✓
    expect(result.as_of_date).toBe('2026-05-31');
  });

  it('skips null OF values (does not clobber existing)', () => {
    const result = mergeOfReturns(
      { ret_1y: 0.125, ret_3y: null },
      { ret_3y: 0.15 },
    );
    expect(result.ret_1y).toBeCloseTo(0.125);
    expect(result.ret_3y).toBeCloseTo(0.15);  // existing preserved when OF null
  });

  it('returns the OF values even when existingBlob is undefined', () => {
    const result = mergeOfReturns({ ret_1y: 0.125, ret_5y: 0.09 }, undefined);
    expect(result.ret_1y).toBeCloseTo(0.125);
    expect(result.ret_5y).toBeCloseTo(0.09);
  });
});
