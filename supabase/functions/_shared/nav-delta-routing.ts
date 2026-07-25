import type { NavBulkItem, NavDeltaResponse } from './openfolio.ts';

export interface OpenFolioNavDeltaRouting {
  usableItems: NavBulkItem[];
  openfolioSchemeCodes: number[];
  fallbackSchemeCodes: number[];
  omittedSchemeCodes: number[];
}

export function planOpenFolioNavDeltaRouting(
  requestedSchemeCodes: number[],
  delta: NavDeltaResponse,
): OpenFolioNavDeltaRouting {
  const matched = new Set(delta.latest.map((item) => item.scheme_code));
  const fallback = new Set<number>([
    ...delta.missing_scheme_codes,
    ...delta.truncated_scheme_codes,
  ]);
  const omittedSchemeCodes: number[] = [];

  for (const schemeCode of requestedSchemeCodes) {
    if (!matched.has(schemeCode) && !fallback.has(schemeCode)) {
      fallback.add(schemeCode);
      omittedSchemeCodes.push(schemeCode);
    }
  }

  return {
    usableItems: delta.items.filter(
      (item) => matched.has(item.scheme_code) && !fallback.has(item.scheme_code),
    ),
    openfolioSchemeCodes: requestedSchemeCodes.filter(
      (schemeCode) => matched.has(schemeCode) && !fallback.has(schemeCode),
    ),
    fallbackSchemeCodes: requestedSchemeCodes.filter((schemeCode) => fallback.has(schemeCode)),
    omittedSchemeCodes,
  };
}
