/**
 * Holding-overlap math for the Compare Funds screen.
 *
 * Jaccard similarity over top equity holdings. ISIN-first matching with a
 * normalised-name fallback so common-name variants ("HDFC Bank Ltd" vs "HDFC
 * Bank Limited") still align.
 */

export interface HoldingItem {
  name: string;
  isin: string | null | undefined;
  pctOfNav?: number;
}

export interface HoldingOverlapResult {
  /** Count of holdings that appear in both A and B. */
  intersectionCount: number;
  /** Count of holdings unique to A or B (the union). */
  unionCount: number;
  /** Jaccard percentage (intersection / union × 100). */
  overlapPct: number;
}

export function holdingsKey(h: Pick<HoldingItem, 'isin' | 'name'>): string {
  if (h.isin && h.isin.trim().length > 0) return `isin:${h.isin.trim().toUpperCase()}`;
  return `name:${h.name.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function computeHoldingOverlap(
  aHoldings: HoldingItem[] | null | undefined,
  bHoldings: HoldingItem[] | null | undefined,
): HoldingOverlapResult {
  if (!aHoldings || !bHoldings || aHoldings.length === 0 || bHoldings.length === 0) {
    return { intersectionCount: 0, unionCount: 0, overlapPct: 0 };
  }
  const aKeys = new Set(aHoldings.map(holdingsKey));
  const bKeys = new Set(bHoldings.map(holdingsKey));
  const intersection = new Set<string>();
  for (const k of aKeys) if (bKeys.has(k)) intersection.add(k);
  const union = new Set<string>([...aKeys, ...bKeys]);
  const overlapPct = union.size > 0 ? (intersection.size / union.size) * 100 : 0;
  return {
    intersectionCount: intersection.size,
    unionCount: union.size,
    overlapPct,
  };
}
