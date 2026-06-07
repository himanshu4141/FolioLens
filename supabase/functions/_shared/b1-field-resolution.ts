import type { B1FieldStatus } from './openfolio.ts';

/**
 * Resolves a single B1 field value given OpenFolio's per-field status and the
 * candidate values from each source.
 *
 * Returns `undefined` (rather than `null`) to mean "no update — preserve the
 * existing DB value." Callers should only write to the payload when the return
 * is not `undefined`:
 *
 *   const v = resolveB1Field(fm.ter?.status, ofMeta.ter, mfdata?.expense_ratio);
 *   if (v !== undefined) payload.expense_ratio = v;
 *
 * Decision table:
 *  'value'              → ofValue ?? null  (OF has a definitive value; null is honest)
 *  'officially_absent'  → null             (source says field doesn't exist; no mfdata override)
 *  'not_applicable'     → null             (field doesn't apply to this fund type; no mfdata override)
 *  'unresolved'         → mfdataValue if present, else undefined (not yet processed; fall back)
 *  'parse_failed'       → mfdataValue if present, else undefined (extraction failed; fall back)
 *  'source_failed'      → mfdataValue if present, else undefined (source fetch failed; fall back)
 *  undefined            → mfdataValue if present, else undefined (absent from b1_field_meta; treat as unresolved)
 */
export function resolveB1Field<T>(
  status: B1FieldStatus | undefined,
  ofValue: T | null | undefined,
  mfdataValue: T | null | undefined,
): T | null | undefined {
  if (status === 'value') return ofValue ?? null;
  if (status === 'officially_absent' || status === 'not_applicable') return null;
  // 'unresolved' | 'parse_failed' | 'source_failed' | undefined → mfdata backup.
  // Return undefined (not null) when mfdata also has nothing, so the caller
  // leaves the existing DB value intact rather than overwriting it with null.
  if (mfdataValue != null) return mfdataValue;
  return undefined;
}
