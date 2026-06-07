import { resolveB1Field } from '../b1-field-resolution';
import type { B1FieldStatus } from '../openfolio';

// Convenience: turn the 3-arg call into a readable label.
type Case = {
  status: B1FieldStatus | undefined;
  ofValue: number | null | undefined;
  mfdataValue: number | null | undefined;
  expected: number | null | undefined;
  label: string;
};

const cases: Case[] = [
  // ── 'value' → use OF value regardless of mfdata ─────────────────────────
  {
    label: "'value', both present → OF wins",
    status: 'value',
    ofValue: 0.89,
    mfdataValue: 1.5,
    expected: 0.89,
  },
  {
    label: "'value', OF null → honest null (not mfdata override)",
    status: 'value',
    ofValue: null,
    mfdataValue: 1.5,
    expected: null,
  },
  {
    label: "'value', OF undefined → null (coerced)",
    status: 'value',
    ofValue: undefined,
    mfdataValue: 1.5,
    expected: null,
  },

  // ── 'officially_absent' → honest null, mfdata ignored ───────────────────
  {
    label: "'officially_absent', mfdata present → null (source says no value exists)",
    status: 'officially_absent',
    ofValue: null,
    mfdataValue: 1.5,
    expected: null,
  },
  {
    label: "'officially_absent', both absent → null",
    status: 'officially_absent',
    ofValue: null,
    mfdataValue: null,
    expected: null,
  },

  // ── 'not_applicable' → honest null, mfdata ignored ──────────────────────
  {
    label: "'not_applicable', mfdata present → null (field doesn't apply to this fund type)",
    status: 'not_applicable',
    ofValue: null,
    mfdataValue: 1.5,
    expected: null,
  },

  // ── 'unresolved' → mfdata backup ─────────────────────────────────────────
  {
    label: "'unresolved', mfdata present → mfdata",
    status: 'unresolved',
    ofValue: null,
    mfdataValue: 1.5,
    expected: 1.5,
  },
  {
    label: "'unresolved', mfdata absent → undefined (preserve existing DB value)",
    status: 'unresolved',
    ofValue: null,
    mfdataValue: null,
    expected: undefined,
  },
  {
    label: "'unresolved', mfdata undefined → undefined",
    status: 'unresolved',
    ofValue: null,
    mfdataValue: undefined,
    expected: undefined,
  },

  // ── 'parse_failed' → mfdata backup ───────────────────────────────────────
  {
    label: "'parse_failed', mfdata present → mfdata",
    status: 'parse_failed',
    ofValue: null,
    mfdataValue: 2.0,
    expected: 2.0,
  },
  {
    label: "'parse_failed', mfdata absent → undefined",
    status: 'parse_failed',
    ofValue: null,
    mfdataValue: null,
    expected: undefined,
  },

  // ── 'source_failed' → mfdata backup ──────────────────────────────────────
  {
    label: "'source_failed', mfdata present → mfdata",
    status: 'source_failed',
    ofValue: null,
    mfdataValue: 0.5,
    expected: 0.5,
  },

  // ── undefined status → treat as 'unresolved' ─────────────────────────────
  {
    label: "undefined status, mfdata present → mfdata (absent field treated as unresolved)",
    status: undefined,
    ofValue: null,
    mfdataValue: 1.2,
    expected: 1.2,
  },
  {
    label: "undefined status, mfdata absent → undefined (don't clobber DB)",
    status: undefined,
    ofValue: null,
    mfdataValue: null,
    expected: undefined,
  },
];

describe('resolveB1Field', () => {
  test.each(cases)('$label', ({ status, ofValue, mfdataValue, expected }) => {
    expect(resolveB1Field(status, ofValue, mfdataValue)).toBe(expected);
  });

  it('works with string values (not just numbers)', () => {
    expect(resolveB1Field<string>('value', 'Nifty 50', 'BSE 500')).toBe('Nifty 50');
    expect(resolveB1Field<string>('unresolved', null, 'BSE 500')).toBe('BSE 500');
    expect(resolveB1Field<string>('officially_absent', null, 'BSE 500')).toBeNull();
    expect(resolveB1Field<string>(undefined, null, null)).toBeUndefined();
  });
});
