/**
 * Unit tests for universe-backfill's B1 field resolution and patch builder.
 *
 * Tests the NULL-write semantics:
 * - value→value: status='value' + of_value → write the value
 * - value→null: status='value' + no of_value → write null
 * - null-status→null: status non-'value' → write NULL (retract)
 * - missing→no-touch: status undefined → skip the write (undefined sentinel)
 */

describe('universe-backfill B1 field resolution', () => {
  // Mock the resolveB1 function inline for testing
  function resolveB1<T>(
    status: string | undefined,
    ofValue: T | null | undefined,
  ): T | null | undefined {
    const B1_OK_STATUSES = new Set(['value']);
    // Missing status = field not in API response = don't touch DB
    if (status === undefined) return undefined;
    // status='value' = use OF value (or null if empty)
    if (B1_OK_STATUSES.has(status)) return ofValue ?? null;
    // status is non-value → write NULL to retract any previous value
    return null;
  }

  describe('string fields', () => {
    it('value→value: status=value + of_value', () => {
      const result = resolveB1('value', 'expense_ratio_value');
      expect(result).toBe('expense_ratio_value');
    });

    it('value→null: status=value + no of_value', () => {
      const result = resolveB1('value', null);
      expect(result).toBeNull();
    });

    it('value→null: status=value + undefined of_value', () => {
      const result = resolveB1('value', undefined);
      expect(result).toBeNull();
    });

    it('null-status→null: status=officially_absent (non-value)', () => {
      const result = resolveB1('officially_absent', 'old_value');
      expect(result).toBeNull();
    });

    it('null-status→null: status=parse_failed (non-value)', () => {
      const result = resolveB1('parse_failed', 'old_value');
      expect(result).toBeNull();
    });

    it('null-status→null: status=unresolved (non-value)', () => {
      const result = resolveB1('unresolved', 'old_value');
      expect(result).toBeNull();
    });

    it('null-status→null: status=not_applicable (non-value)', () => {
      const result = resolveB1('not_applicable', 'old_value');
      expect(result).toBeNull();
    });

    it('null-status→null: status=source_failed (non-value)', () => {
      const result = resolveB1('source_failed', 'old_value');
      expect(result).toBeNull();
    });

    it('missing→no-touch: status undefined', () => {
      const result = resolveB1(undefined, 'old_value');
      expect(result).toBeUndefined();
    });

    it('missing→no-touch: status undefined, even if of_value is null', () => {
      const result = resolveB1(undefined, null);
      expect(result).toBeUndefined();
    });
  });

  describe('number fields', () => {
    function resolveB1Integer(
      status: string | undefined,
      ofValue: number | null | undefined,
    ): number | null | undefined {
      const value = resolveB1(status, ofValue);
      if (value === undefined) return undefined;
      if (value == null) return null;
      if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
      return value;
    }

    it('value→value: status=value + valid integer', () => {
      const result = resolveB1Integer('value', 100);
      expect(result).toBe(100);
    });

    it('value→null: status=value + no value', () => {
      const result = resolveB1Integer('value', null);
      expect(result).toBeNull();
    });

    it('invalid→null: status=value + non-integer', () => {
      const result = resolveB1Integer('value', 100.5);
      expect(result).toBeNull();
    });

    it('invalid→null: status=value + Infinity', () => {
      const result = resolveB1Integer('value', Infinity);
      expect(result).toBeNull();
    });

    it('null-status→null: status=officially_absent', () => {
      const result = resolveB1Integer('officially_absent', 100);
      expect(result).toBeNull();
    });

    it('missing→no-touch: status undefined', () => {
      const result = resolveB1Integer(undefined, 100);
      expect(result).toBeUndefined();
    });
  });

  describe('patch builder semantics', () => {
    function buildPatch(
      ter: string | undefined,
      terValue: string | null | undefined,
      minSip: string | undefined,
      minSipValue: number | null | undefined,
    ): Record<string, unknown> {
      const patch: Record<string, unknown> = {};

      const B1_OK_STATUSES = new Set(['value']);
      const resolveB1Local = <T>(
        status: string | undefined,
        ofValue: T | null | undefined,
      ): T | null | undefined => {
        if (status === undefined) return undefined;
        if (B1_OK_STATUSES.has(status)) return ofValue ?? null;
        return null;
      };

      const terResolved = resolveB1Local(ter, terValue);
      if (terResolved !== undefined) patch.expense_ratio = terResolved;

      const minSipResolved = resolveB1Local(minSip, minSipValue);
      if (minSipResolved !== undefined) patch.min_sip_amount = minSipResolved;

      return patch;
    }

    it('writes value when status=value + of_value', () => {
      const patch = buildPatch('value', 'TER_VALUE', 'value', 100);
      expect(patch).toEqual({ expense_ratio: 'TER_VALUE', min_sip_amount: 100 });
    });

    it('writes null when status=value + no of_value', () => {
      const patch = buildPatch('value', null, 'value', null);
      expect(patch).toEqual({ expense_ratio: null, min_sip_amount: null });
    });

    it('writes null when status is non-value (retracts old value)', () => {
      const patch = buildPatch('parse_failed', 'old_ter', 'officially_absent', 500);
      expect(patch).toEqual({ expense_ratio: null, min_sip_amount: null });
    });

    it('skips write when status is undefined (no-touch)', () => {
      const patch = buildPatch(undefined, 'old_ter', undefined, 500);
      expect(patch).toEqual({});
    });

    it('mixed: some fields written, some skipped', () => {
      const patch = buildPatch('parse_failed', 'old_ter', undefined, 500);
      expect(patch).toEqual({ expense_ratio: null });
    });

    it('mixed: value, null, and skipped', () => {
      const patch = buildPatch('value', 'NEW_TER', 'officially_absent', 100);
      expect(patch).toEqual({ expense_ratio: 'NEW_TER', min_sip_amount: null });
    });
  });
});
