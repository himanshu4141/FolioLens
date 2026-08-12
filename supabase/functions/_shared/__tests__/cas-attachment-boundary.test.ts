import { hasCrossAttachmentSchemeOverlap } from '../cas-attachment-boundary';
import type { CanonicalCASParseResult } from '../cas-import-contract';

function payload(code: string, occurrences = 1): CanonicalCASParseResult {
  return {
    contract_version: 1,
    source_dialect: 'cams',
    mutual_funds: [{
      folio_number: null,
      schemes: Array.from({ length: occurrences }, () => ({
        name: 'Synthetic Fund',
        isin: 'INF000000001',
        units: 1,
        additional_info: { amfi: code },
        transactions: [],
      })),
    }],
  };
}

describe('inbound CAS attachment boundary', () => {
  it('allows repeated folios for one scheme inside one statement', () => {
    expect(hasCrossAttachmentSchemeOverlap([payload('101', 2)])).toBe(false);
  });

  it('rejects duplicate or overlapping statements for the same scheme', () => {
    expect(hasCrossAttachmentSchemeOverlap([payload('101'), payload('101')])).toBe(true);
    expect(hasCrossAttachmentSchemeOverlap([payload('00101'), payload('101')])).toBe(true);
  });

  it('allows disjoint statements to share one atomic mutation', () => {
    expect(hasCrossAttachmentSchemeOverlap([payload('101'), payload('202')])).toBe(false);
  });
});
