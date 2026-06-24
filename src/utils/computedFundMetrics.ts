/**
 * Locally-computed fund metrics from NAV history — used by the Compare Funds
 * deep-redesign (M3v2). We compute these locally instead of trusting MFData
 * because the MFData accuracy comparison
 * (docs/research/mfdata-accuracy-comparison.md) found:
 *
 *  - 1Y CAGR: stale by 1–3pp, with one 55pp blowup; only 3/14 funds within
 *    0.5pp of AMFI ground truth.
 *  - Sharpe / Sortino: sign-flipped on 11/14 equity funds because MFData
 *    appears to use a 1Y rolling window where Indian equities trail the
 *    risk-free rate.
 *
 * What this module does NOT compute: Beta, R², Alpha. These need a benchmark
 * series and (for Alpha) a risk model; we don't have a curated benchmark
 * series per fund yet. MFData's beta/r_squared on equity funds is reasonable;
 * the screen reads those from `scheme_master.risk_ratios` with category
 * gating (see `mfdataGuards.ts`).
 */
import type { NavPoint } from './navUtils';
import { readMfdataAsOfDate, readMfdataStdDev, readReturnPct, readOfMaxDrawdown } from './mfdataGuards';

/**
 * Default annual risk-free rate for Sharpe / Sortino (current Indian 1Y T-bill
 * yield range). Caller can override.
 */
export const DEFAULT_RISK_FREE_RATE = 0.065;

/** Periods per year for monthly returns. */
const MONTHS_PER_YEAR = 12;

/**
 * Sample-stdev (Bessel-corrected) of a number array. Returns null for arrays
 * shorter than 2 — no variance with one or zero observations.
 */
export function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sqDiff = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return Math.sqrt(sqDiff / (values.length - 1));
}

/**
 * Mean of a number array. Returns null for empty arrays.
 */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Pull the last NAV on or before a given date string ('YYYY-MM-DD'). Returns
 * null if the series has no NAV on or before the target.
 */
export function navOnOrBefore(series: NavPoint[], target: string): NavPoint | null {
  let result: NavPoint | null = null;
  for (const point of series) {
    if (point.date <= target) {
      if (!result || point.date > result.date) result = point;
    }
  }
  return result;
}

/**
 * Build a series of month-end NAV points from a full NAV history.
 *
 * For each month covered by the series, picks the last NAV with a date in that
 * month. Output is sorted ascending. Skips months that don't have a NAV.
 */
export function buildMonthEndNavs(series: NavPoint[]): NavPoint[] {
  if (series.length === 0) return [];
  const byMonth = new Map<string, NavPoint>();
  for (const point of series) {
    if (!point.date || !Number.isFinite(point.value) || point.value <= 0) continue;
    const monthKey = point.date.slice(0, 7); // 'YYYY-MM'
    const existing = byMonth.get(monthKey);
    if (!existing || point.date > existing.date) byMonth.set(monthKey, point);
  }
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Compute monthly simple returns from a series of month-end NAVs. Returns one
 * fewer value than the input (the first month has no prior to diff against).
 *
 * Filters out non-finite results (e.g. NAV resets, missing months).
 */
export function computeMonthlyReturns(monthEndNavs: NavPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < monthEndNavs.length; i++) {
    const prev = monthEndNavs[i - 1].value;
    const curr = monthEndNavs[i].value;
    if (prev <= 0 || curr <= 0) continue;
    const ret = curr / prev - 1;
    if (Number.isFinite(ret)) out.push(ret);
  }
  return out;
}

/**
 * Annualised CAGR over the trailing N years from the latest NAV. Returns null
 * when the series is too short (must span at least N years), the start/end
 * NAVs are non-positive, or the result is non-finite.
 */
export function computeTrailingCagr(
  series: NavPoint[],
  years: number,
  today?: Date,
): number | null {
  if (series.length === 0 || years <= 0) return null;
  const now = today ?? new Date();
  const targetDate = new Date(now);
  targetDate.setFullYear(targetDate.getFullYear() - years);
  const targetStr = targetDate.toISOString().split('T')[0];

  const seriesFirst = series[0];
  if (seriesFirst.date > targetStr) return null;

  const startNav = navOnOrBefore(series, targetStr);
  const endNav = series[series.length - 1];
  if (!startNav || startNav.value <= 0 || endNav.value <= 0) return null;

  const ratio = endNav.value / startNav.value;
  if (ratio <= 0) return null;
  const cagr = Math.pow(ratio, 1 / years) - 1;
  return Number.isFinite(cagr) ? cagr : null;
}

interface RiskMetricsInput {
  /** Trailing window in years for the risk computation (default: 3). */
  windowYears?: number;
  /** Annual risk-free rate as a decimal (default: 0.065 = 6.5%). */
  annualRiskFreeRate?: number;
  /** Today's date — for testability. */
  today?: Date;
}

interface RiskMetricsResult {
  /** Annualised standard deviation of monthly returns (decimal, e.g. 0.18 = 18%). */
  stdDev: number | null;
  /** Annualised Sharpe ratio. */
  sharpe: number | null;
  /** Annualised Sortino ratio (only downside deviation in the denominator). */
  sortino: number | null;
  /** Number of monthly observations the metrics were computed from. */
  monthlyObservations: number;
}

/**
 * Compute Std dev / Sharpe / Sortino over the trailing windowYears of monthly
 * returns. Returns nulls when the series is too short (fewer than 12
 * observations after windowing). All outputs are annualised.
 */
export function computeRiskMetrics(
  series: NavPoint[],
  input: RiskMetricsInput = {},
): RiskMetricsResult {
  const windowYears = input.windowYears ?? 3;
  const annualRiskFreeRate = input.annualRiskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const today = input.today ?? new Date();

  // Window the series to the trailing windowYears.
  const cutoff = new Date(today);
  cutoff.setFullYear(cutoff.getFullYear() - windowYears);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const windowed = series.filter((p) => p.date >= cutoffStr);

  const monthEnds = buildMonthEndNavs(windowed);
  const monthly = computeMonthlyReturns(monthEnds);

  if (monthly.length < 12) {
    return { stdDev: null, sharpe: null, sortino: null, monthlyObservations: monthly.length };
  }

  const monthlyRf = annualRiskFreeRate / MONTHS_PER_YEAR;
  const excessMonthly = monthly.map((r) => r - monthlyRf);

  const monthlyStd = sampleStdDev(monthly);
  const annualStd = monthlyStd != null ? monthlyStd * Math.sqrt(MONTHS_PER_YEAR) : null;

  const meanExcess = mean(excessMonthly);
  const annualMeanExcess = meanExcess != null ? meanExcess * MONTHS_PER_YEAR : null;

  const sharpe =
    annualMeanExcess != null && annualStd != null && annualStd > 0
      ? annualMeanExcess / annualStd
      : null;

  // Sortino — denominator is downside-only deviation against the risk-free
  // rate. Use period-based downside std (preserves zero-downside case).
  const downsideMonthly = excessMonthly.filter((r) => r < 0);
  let sortino: number | null = null;
  if (downsideMonthly.length >= 2 && annualMeanExcess != null) {
    // Sample-stdev of downside excess returns, then annualise.
    const dStd = sampleStdDev(downsideMonthly);
    const annualDownsideStd = dStd != null ? dStd * Math.sqrt(MONTHS_PER_YEAR) : null;
    if (annualDownsideStd != null && annualDownsideStd > 0) {
      sortino = annualMeanExcess / annualDownsideStd;
    }
  } else if (downsideMonthly.length === 0 && annualMeanExcess != null && annualMeanExcess > 0) {
    // Zero downside in the window — Sortino is conventionally infinite. We
    // surface null and let the caller decide ("no downside in 3 years" is
    // worth its own phrasing rather than a number).
    sortino = null;
  }

  return {
    stdDev: annualStd,
    sharpe,
    sortino,
    monthlyObservations: monthly.length,
  };
}

/**
 * Trailing-period summary used by the Compare Funds Returns tab. Returns the
 * 1Y / 3Y / 5Y CAGR plus the count of NAVs available, so the screen can
 * decide between rendering the value or showing "—".
 */
export interface TrailingPeriodReturns {
  y1: number | null;
  y3: number | null;
  y5: number | null;
  navCount: number;
  earliestDate: string | null;
  latestDate: string | null;
}

export function computeTrailingReturns(
  series: NavPoint[],
  today?: Date,
): TrailingPeriodReturns {
  const sorted = [...series]
    .filter((p) => p.date && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    y1: computeTrailingCagr(sorted, 1, today),
    y3: computeTrailingCagr(sorted, 3, today),
    y5: computeTrailingCagr(sorted, 5, today),
    navCount: sorted.length,
    earliestDate: sorted.length ? sorted[0].date : null,
    latestDate: sorted.length ? sorted[sorted.length - 1].date : null,
  };
}

/**
 * Worst peak-to-trough drawdown over the trailing 5 years. Returns null when
 * the series has fewer than 10 valid data points in the window, or when the
 * maximum drop is less than 0.1% (effectively zero).
 *
 * Returns a negative decimal (e.g. -0.26 for a 26% drawdown).
 */
export function computeMaxDrawdown(series: NavPoint[], today?: Date): number | null {
  const now = today ?? new Date();
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const sorted = [...series]
    .filter((p) => p.date >= cutoffStr && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 10) return null;
  let peak = sorted[0].value;
  let maxDD = 0;
  for (const p of sorted) {
    if (p.value > peak) peak = p.value;
    const dd = (p.value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD < -0.001 ? maxDD : null;
}

/** Source of a fund's displayed metrics in the Compare screen. */
export type MetricsSource = 'computed' | 'as-reported';

/**
 * Full metrics bundle used by the Compare Funds screen.
 * When `source === 'as-reported'` the values come from the database-persisted
 * period_returns / risk_ratios blobs; Sharpe, Sortino, and maxDrawdown are
 * null because they require full NAV history to compute. `returnsAsOf` and
 * `riskAsOf` carry the as_of_date from those blobs so the UI can label the
 * provenance.
 */
export interface CompareMetrics {
  trailing: TrailingPeriodReturns;
  sharpe: number | null;
  sortino: number | null;
  stdDev: number | null;
  monthlyObservations: number;
  maxDrawdown: number | null;
  source: MetricsSource;
  /** Only set when source === 'as-reported'; from period_returns.as_of_date. */
  returnsAsOf: string | null;
  /** Only set when source === 'as-reported'; from risk_ratios.as_of_date. */
  riskAsOf: string | null;
}

/**
 * Returns true when a scheme is a payout plan (IDCW / dividend / payout / etc.)
 * whose locally-computed NAV metrics must be bypassed in favour of the
 * as-reported blob.
 *
 * Ported from upstream is_idcw_scheme logic. Rules:
 *  - option_type starting with "growth" → never a payout plan.
 *  - option_type starting with an IDCW / payout / dividend / reinvest / bonus
 *    keyword → always a payout plan.
 *  - "Dividend Yield" in the fund base name is a strategy (invests in
 *    dividend-paying stocks), NOT a distribution type: flag it only when an
 *    IDCW or other payout marker is also present in the name (e.g.
 *    "…Dividend Yield Fund - IDCW" → payout;
 *    "…Dividend Yield Fund - Growth" → not payout).
 *  - Otherwise check the name for IDCW / income-distribution / payout /
 *    reinvest / bonus / bare-dividend (after stripping "dividend yield").
 */
export function isPayoutPlan(schemeName: string, optionType: string | null | undefined): boolean {
  const opt = (optionType ?? '').trim().toLowerCase();

  // Explicit Growth option_type → not a payout plan.
  if (/^growth/.test(opt)) return false;

  // option_type carries a payout marker → flag immediately.
  if (opt && /^(?:idcw|payout|income[\s-]?distribution|reinvest(?:ment)?|bonus|dividend)/.test(opt)) return true;

  const n = schemeName.trim().toLowerCase();

  // IDCW anywhere in the name → always a payout plan (never used as a
  // strategy name, unlike "Dividend Yield").
  if (/\bidcw\b/.test(n)) return true;

  // Full "income distribution" phrase (pre-SEBI-rename wording).
  if (/\bincome\s+distribution\b/.test(n)) return true;

  // "Payout" as a word — always a distribution marker.
  if (/\bpayout\b/.test(n)) return true;

  // "Reinvest" / "Reinvestment" — IDCW reinvested into units.
  if (/\breinvest(?:ment)?\b/.test(n)) return true;

  // "Bonus" option — additional units distributed as bonus dividend.
  if (/\bbonus\b/.test(n)) return true;

  // "Dividend" as a payout option — but NOT the "Dividend Yield" strategy.
  // Strip "dividend yield" occurrences first, then check for bare "dividend".
  const withoutDivYield = n.replace(/\bdividend\s+yield\b/g, '');
  if (/\bdividend\b/.test(withoutDivYield)) return true;

  return false;
}

/**
 * Select the best available metrics for a fund in the Compare screen.
 *
 * Priority: computed from local NAV series (if any trailing return is non-null
 * AND the fund is not a payout plan) > as-reported from period_returns /
 * risk_ratios blobs.
 *
 * Payout plans (IDCW / dividend / etc.) always use the as-reported blob:
 * their NAV is distorted by distributions so locally-computed CAGRs and
 * drawdown are misleading. OpenFolio #65 populated the as-reported blob with
 * the Growth-twin's correct numbers for ~82% of payout schemes.
 *
 * Returns null when neither source has any return data.
 *
 * Design note — never mix sources within a single fund's metrics: if the local
 * series can compute y1 but not y3/y5, we still use the computed source and
 * show "—" for y3/y5 rather than filling in the gaps from period_returns.
 * This prevents "computed locally" and "as reported" from silently coexisting
 * in the same row.
 *
 * Source-swap rule — only switch from as-reported to computed when computed
 * adds information as-reported doesn't carry (Sharpe / Sortino). If the
 * computed path yields the same CAGR / σ / drawdown but no Sharpe/Sortino,
 * keeping as-reported avoids a visible value-flip with near-identical numbers
 * when the NAV series loads (typically from month-end points).
 */
export function selectCompareMetrics(
  series: NavPoint[],
  periodReturns: unknown,
  riskRatios: unknown,
  today?: Date,
  schemeName?: string,
  optionType?: string | null,
): CompareMetrics | null {
  const trailing = computeTrailingReturns(series, today);
  const hasComputed = trailing.y1 != null || trailing.y3 != null || trailing.y5 != null;

  // Skip computed branch for payout plans: their NAV reflects distributions
  // and distorts CAGR/drawdown. schemeName absent → legacy call, preserve
  // existing behaviour.
  if (hasComputed && !(schemeName != null && isPayoutPlan(schemeName, optionType))) {
    const risk = computeRiskMetrics(series, { windowYears: 3, today });
    const maxDrawdown = computeMaxDrawdown(series, today);

    // Only recompute-swap when computed adds Sharpe / Sortino (not available
    // from the as-reported blob). If as-reported already covers returns and
    // computed can't produce Sharpe/Sortino (too few monthly observations),
    // stay with as-reported to prevent a jarring value-flip for identical numbers.
    const asReportedHasReturns =
      readReturnPct(periodReturns, '1y') != null ||
      readReturnPct(periodReturns, '3y') != null ||
      readReturnPct(periodReturns, '5y') != null;
    const computedAddsValue = risk.sharpe != null || risk.sortino != null;
    if (asReportedHasReturns && !computedAddsValue) {
      // Fall through to the as-reported path below.
    } else {
      return { trailing, ...risk, maxDrawdown, source: 'computed', returnsAsOf: null, riskAsOf: null };
    }
  }

  // Fall back to the persisted as-reported blobs.
  const pct1y = readReturnPct(periodReturns, '1y');
  const pct3y = readReturnPct(periodReturns, '3y');
  const pct5y = readReturnPct(periodReturns, '5y');
  if (pct1y == null && pct3y == null && pct5y == null) return null;

  const stdDevPct = readMfdataStdDev(riskRatios);
  const maxDD = readOfMaxDrawdown(riskRatios);
  return {
    trailing: {
      y1: pct1y != null ? pct1y / 100 : null,
      y3: pct3y != null ? pct3y / 100 : null,
      y5: pct5y != null ? pct5y / 100 : null,
      navCount: 0,
      earliestDate: null,
      latestDate: null,
    },
    stdDev: stdDevPct != null ? stdDevPct / 100 : null,
    sharpe: null,
    sortino: null,
    monthlyObservations: 0,
    maxDrawdown: maxDD,
    source: 'as-reported',
    returnsAsOf: readMfdataAsOfDate(periodReturns),
    riskAsOf: readMfdataAsOfDate(riskRatios),
  };
}
