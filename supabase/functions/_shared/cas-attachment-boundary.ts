import type { CanonicalCASParseResult } from './cas-import-contract';

export function hasCrossAttachmentSchemeOverlap(
  payloads: CanonicalCASParseResult[],
): boolean {
  const seen = new Set<string>();
  for (const payload of payloads) {
    const current = new Set<string>();
    for (const folio of payload.mutual_funds) {
      for (const scheme of folio.schemes) {
        current.add(String(Number.parseInt(scheme.additional_info.amfi, 10)));
      }
    }
    for (const code of current) {
      if (seen.has(code)) return true;
      seen.add(code);
    }
  }
  return false;
}
