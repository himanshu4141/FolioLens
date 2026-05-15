/**
 * Pure utility functions for fund portfolio composition logic.
 * Extracted to _shared/ so they can be tested under Jest (no Deno deps).
 */

export interface CategoryComposition {
  equity: number;
  debt: number;
  cash: number;
  other: number;
  large: number;
  mid: number;
  small: number;
}

export interface DebtHolding {
  holding_type?: string;
  credit_rating?: string;
  weight_pct?: number;
}

export interface EquityHolding {
  stock_name?: string;
  isin?: string | null;
  sector?: string | null;
  weight_pct?: number;
}

export type MarketCapCategory = 'Large Cap' | 'Mid Cap' | 'Small Cap';

export interface CapClassification {
  /** % of total NAV attributed to large-cap holdings. */
  largeCapPct: number;
  /** % of total NAV attributed to mid-cap holdings. */
  midCapPct: number;
  /** % of total NAV attributed to small-cap holdings. */
  smallCapPct: number;
  /**
   * % of total NAV in equity holdings that could not be classified — either
   * the ISIN was missing/blank or wasn't found in the AMFI list. Foreign
   * equities (e.g. Alphabet, Amazon held by Parag Parikh) flow into this
   * bucket because they don't appear in AMFI's domestic categorization.
   */
  notClassifiedPct: number;
  /** Copy of input holdings with each holding's `marketCap` filled in. */
  annotated: Array<EquityHolding & { marketCap: MarketCapCategory | 'Other' }>;
}

/** Returns true if value is a numeric string (e.g. "-14.30", "23.23"). */
export function isNumericString(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * Returns true if the debt_holdings array is corrupted.
 *
 * Some fund families (confirmed: pure-equity large-cap and overseas funds)
 * have benchmark performance data injected into debt_holdings with numeric
 * strings as holding_type or credit_rating. Discard the entire array when
 * this pattern is detected rather than silently computing a wrong debt_pct.
 */
export function isDebtDataCorrupted(debtHoldings: DebtHolding[]): boolean {
  return debtHoldings.some(
    (h) => isNumericString(h.holding_type) || isNumericString(h.credit_rating),
  );
}

/** Sum weight_pct across all debt holdings to derive debt_pct. */
export function deriveDebtPct(debtHoldings: DebtHolding[]): number {
  return debtHoldings.reduce((sum, h) => sum + (h.weight_pct ?? 0), 0);
}

/**
 * Returns false if equity_pct is obviously wrong for the given category rules.
 *
 * Two guards:
 *   1. Pure equity funds (catRules.equity >= 80): reject if equity_pct < 50.
 *      These funds are legally required to hold 80%+ equity; reporting <50% is
 *      a corrupt API response, not a real allocation shift.
 *   2. Pure debt funds (catRules.debt >= 80): reject if equity_pct > 20.
 *      Deliberately uses debt >= 80 rather than equity <= 10 to avoid rejecting
 *      overseas FoF funds, which also have equity=0 in catRules but legitimately
 *      return high equity_pct values from mfdata.in (ETFs in equity_holdings).
 */
export function isEquityPctPlausible(equityPct: number, catRules: CategoryComposition): boolean {
  if (catRules.equity >= 80 && equityPct < 50) return false;
  if (catRules.debt >= 80 && equityPct > 20) return false;
  return true;
}

/**
 * Returns true if the equity_holdings array is corrupted.
 *
 * Parallels `isDebtDataCorrupted`. mfdata.in occasionally returns benchmark
 * performance rows inside equity_holdings — recognisable by a numeric
 * `stock_name` (e.g. "-14.30"), a non-ISIN `isin` value, or a `weight_pct`
 * outside [0, 100]. Discard the entire array when this pattern is detected
 * rather than letting one bad row pollute both sector_allocation and the
 * market-cap classifier.
 */
export function isEquityHoldingsCorrupted(holdings: EquityHolding[]): boolean {
  if (holdings.length === 0) return false;
  let suspicious = 0;
  for (const h of holdings) {
    if (isNumericString(h.stock_name)) suspicious += 1;
    if (typeof h.weight_pct === 'number' && (h.weight_pct < 0 || h.weight_pct > 100)) suspicious += 1;
  }
  // A single bad row is enough to taint the array — sector aggregation sums every row.
  return suspicious > 0;
}

/**
 * Classifies equity holdings into Large/Mid/Small cap buckets using the AMFI
 * ISIN → category map (loaded from `stock_market_cap`).
 *
 * Returns pcts as a share of total NAV (not of equity). For a fund that's
 * 93% equity and 7% cash with all equity in large caps, this returns
 * `{ largeCapPct: 93, midCapPct: 0, smallCapPct: 0, notClassifiedPct: 0 }`.
 *
 * Each output bucket is independent — `largeCapPct + midCapPct + smallCapPct +
 * notClassifiedPct` should sum to roughly the fund's equity_pct, never to 100.
 *
 * ISIN matching is case-insensitive and tolerates surrounding whitespace.
 * Holdings with missing/blank ISIN flow into `notClassifiedPct`.
 *
 * `annotated` returns the input array with each holding's `marketCap` filled
 * in — `'Large Cap'` | `'Mid Cap'` | `'Small Cap'` for classified holdings,
 * `'Other'` for unclassified ones (preserving the previous default for
 * downstream readers that handle `'Other'` already).
 */
export function classifyHoldings(
  holdings: EquityHolding[],
  isinToCap: Map<string, MarketCapCategory>,
): CapClassification {
  let largeCapPct = 0;
  let midCapPct = 0;
  let smallCapPct = 0;
  let notClassifiedPct = 0;
  const annotated: CapClassification['annotated'] = [];

  for (const h of holdings) {
    const weight = typeof h.weight_pct === 'number' ? h.weight_pct : 0;
    if (weight <= 0) {
      annotated.push({ ...h, marketCap: 'Other' });
      continue;
    }

    const isinKey = (h.isin ?? '').trim().toUpperCase();
    const category = isinKey ? isinToCap.get(isinKey) : undefined;

    if (category === 'Large Cap') {
      largeCapPct += weight;
      annotated.push({ ...h, marketCap: 'Large Cap' });
    } else if (category === 'Mid Cap') {
      midCapPct += weight;
      annotated.push({ ...h, marketCap: 'Mid Cap' });
    } else if (category === 'Small Cap') {
      smallCapPct += weight;
      annotated.push({ ...h, marketCap: 'Small Cap' });
    } else {
      notClassifiedPct += weight;
      annotated.push({ ...h, marketCap: 'Other' });
    }
  }

  return {
    largeCapPct: Math.round(largeCapPct * 100) / 100,
    midCapPct: Math.round(midCapPct * 100) / 100,
    smallCapPct: Math.round(smallCapPct * 100) / 100,
    notClassifiedPct: Math.round(notClassifiedPct * 100) / 100,
    annotated,
  };
}
