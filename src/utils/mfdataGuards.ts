/**
 * Read-time guards for MFData blobs persisted in scheme_master.
 *
 * Per the MFData accuracy comparison
 * (docs/research/mfdata-accuracy-comparison.md), MFData's payload has known
 * unreliability patterns that we filter out at the surface:
 *
 *  1. Composition guards: equity_pct / debt_pct / cash_pct / other_pct
 *     should sum to ~100. When the sum is > 105 the holdings payload was
 *     polluted with benchmark-return rows; we reject the composition.
 *
 *  2. Category-aware risk gating: MFData runs equity-style ratios (Sharpe,
 *     Sortino, Beta, Alpha) on liquid / debt / gilt / money-market funds
 *     where they're nonsense (HDFC Liquid: Beta=1.4, Sortino=21). We hide
 *     beta + r_squared for those categories. We never surface MFData's
 *     Sharpe/Sortino/Alpha for any category — they're 1Y windowed and
 *     sign-flipped on equity funds.
 *
 *  3. Inception-date label: launch_date == '2013-01-01' on AMFI direct-plan
 *     codes is the SEBI direct-plan introduction date, not real inception.
 *     The UI should label these as "Direct plan since" rather than
 *     "Fund inception".
 *
 * The existing guards in supabase/functions/_shared/portfolio-utils.ts
 * (`isDebtDataCorrupted`, `isEquityPctPlausible`) cover the importer side;
 * this module covers the read side.
 */

/**
 * SEBI's direct-plan introduction date. AMFI direct-plan scheme codes
 * frequently show this as `launch_date` because that's when the direct
 * variant was created — not when the underlying fund was launched. The UI
 * should label these as "Direct plan since" not "Fund inception".
 */
export const SEBI_DIRECT_PLAN_INTRODUCTION_DATE = '2013-01-01';

/**
 * Returns true when the asset-allocation percentages add up to a value that
 * indicates the holdings payload was polluted (typically MFData injecting
 * benchmark-return rows as holdings). Threshold: >105% sum.
 */
export function isCompositionImplausible(
  equityPct: number | null | undefined,
  debtPct: number | null | undefined,
  cashPct: number | null | undefined,
  otherPct: number | null | undefined,
): boolean {
  const sum =
    (equityPct ?? 0) + (debtPct ?? 0) + (cashPct ?? 0) + (otherPct ?? 0);
  return sum > 105;
}

/**
 * Categories where MFData's risk ratios (beta, r_squared, std_deviation)
 * are unreliable because they apply equity methodology to non-equity funds.
 * Returning true means the UI should hide MFData's risk numbers for this
 * fund (we still surface our own locally-computed std-dev, since it's just
 * a measure of NAV volatility and applies to any fund).
 */
const NON_EQUITY_RISK_BLOCKED_CATEGORIES = new Set([
  'liquid fund',
  'overnight fund',
  'ultra short duration fund',
  'low duration fund',
  'short duration fund',
  'medium duration fund',
  'medium to long duration fund',
  'long duration fund',
  'money market fund',
  'gilt fund',
  'corporate bond fund',
  'credit risk fund',
  'banking and psu fund',
  'dynamic bond fund',
  'floater fund',
  'arbitrage fund', // technically equity but uses cash-and-carry; volatility is ~debt
]);

export function isRiskRatioCategoryBlocked(category: string | null | undefined): boolean {
  if (!category) return false;
  const key = category.toLowerCase().trim();
  if (NON_EQUITY_RISK_BLOCKED_CATEGORIES.has(key)) return true;
  // Catch "Debt: ..." prefixed categories that the importer surfaces.
  if (key.startsWith('debt')) return true;
  return false;
}

/**
 * Whether the given launch_date is the SEBI direct-plan introduction date.
 * UI uses this to flip the label from "Fund inception" to "Direct plan since".
 */
export function isLaunchDateDirectPlanIntroduction(
  launchDate: string | null | undefined,
): boolean {
  if (!launchDate) return false;
  return launchDate.startsWith(SEBI_DIRECT_PLAN_INTRODUCTION_DATE);
}

/**
 * Pluck the beta from a persisted risk_ratios JSONB blob. Returns null if the
 * blob is absent, the field is missing, or the category is in the
 * risk-ratio-blocked set.
 *
 * Shape (from MFData):
 *   { risk: { beta, r_squared, std_deviation, sortino_ratio }, ... }
 *
 * We only surface beta + r_squared, and only for non-blocked categories.
 */
export function readMfdataBeta(
  riskRatios: unknown,
  category: string | null | undefined,
): number | null {
  if (isRiskRatioCategoryBlocked(category)) return null;
  if (!riskRatios || typeof riskRatios !== 'object') return null;
  const risk = (riskRatios as { risk?: unknown }).risk;
  if (!risk || typeof risk !== 'object') return null;
  const beta = (risk as { beta?: unknown }).beta;
  return typeof beta === 'number' && Number.isFinite(beta) ? beta : null;
}

export function readMfdataRSquared(
  riskRatios: unknown,
  category: string | null | undefined,
): number | null {
  if (isRiskRatioCategoryBlocked(category)) return null;
  if (!riskRatios || typeof riskRatios !== 'object') return null;
  const risk = (riskRatios as { risk?: unknown }).risk;
  if (!risk || typeof risk !== 'object') return null;
  const r2 = (risk as { r_squared?: unknown }).r_squared;
  return typeof r2 === 'number' && Number.isFinite(r2) ? r2 : null;
}

/**
 * Read the reported standard deviation (annualised volatility) from a
 * risk_ratios blob. MFData stores this as a percentage (e.g. 18.5 for 18.5%).
 * Returns null when absent, non-finite, or negative.
 *
 * No category gating — NAV volatility is a valid measure for any fund type.
 */
export function readMfdataStdDev(riskRatios: unknown): number | null {
  if (!riskRatios || typeof riskRatios !== 'object') return null;
  const risk = (riskRatios as { risk?: unknown }).risk;
  if (!risk || typeof risk !== 'object') return null;
  const sd = (risk as { std_deviation?: unknown }).std_deviation;
  return typeof sd === 'number' && Number.isFinite(sd) && sd >= 0 ? sd : null;
}

/**
 * Read a CAGR return for a given horizon from period_returns, returning a
 * percentage value (e.g. 12.5 means 12.5%) regardless of the blob's source.
 * Handles two storage formats:
 *   - OF: ret_1y / ret_3y / ret_5y stored as decimal CAGRs (0.125 → 12.5%)
 *   - mfdata: return_1y / return_3y / return_5y stored as percentage points (12.5)
 */
export function readReturnPct(
  periodReturns: unknown,
  key: '1y' | '3y' | '5y',
): number | null {
  if (!periodReturns || typeof periodReturns !== 'object') return null;
  const blob = periodReturns as Record<string, unknown>;
  const ofVal = blob[`ret_${key}`];
  if (typeof ofVal === 'number' && Number.isFinite(ofVal)) return ofVal * 100;
  const mfdataVal = blob[`return_${key}`];
  if (typeof mfdataVal === 'number' && Number.isFinite(mfdataVal)) return mfdataVal;
  return null;
}

/** Pluck the as_of_date from a returns or ratios blob. */
export function readMfdataAsOfDate(blob: unknown): string | null {
  if (!blob || typeof blob !== 'object') return null;
  const d = (blob as { as_of_date?: unknown }).as_of_date;
  return typeof d === 'string' && d.length > 0 ? d : null;
}
