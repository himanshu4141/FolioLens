/**
 * Past SIP Check — pure simulation utilities.
 *
 * Given a NAV history series, a fixed monthly SIP amount, and a date range,
 * simulates how much would have been invested, how many units would have been
 * accumulated, and what the holding would be worth today. Computes XIRR using
 * the existing utility in src/utils/xirr.ts.
 *
 * Date discipline:
 *  - All dates are 'YYYY-MM-DD' strings.
 *  - The intended SIP date is the 1st of each month inside [startDate, endDate].
 *  - For each intended SIP date we use the *first* NAV row on or after that date
 *    (handles weekends and holidays). This is the same nearest-forward-NAV
 *    approach used elsewhere in the app.
 *  - If a fund's NAV history begins after the requested start, the simulation
 *    silently rolls forward and reports `shortHistory: true` so the UI can
 *    surface the truncation.
 *
 * The simulation is a pure function of its inputs — it makes no Supabase calls
 * and has no React Native dependencies. Callers fetch NAV history (e.g. via
 * fetchPerformanceTimeline) and pass the series in.
 */
import { xirr, type Cashflow } from './xirr';
import type { NavPoint } from './navUtils';

export type PastSipDuration = '1Y' | '3Y' | '5Y' | 'All';

export interface PastSipInput {
  navSeries: NavPoint[];     // sorted ascending by date
  monthlyAmount: number;     // ₹ per month
  duration: PastSipDuration;
  /** Override "today" — only used in tests. */
  today?: Date;
}

export interface PastSipInstallment {
  intendedDate: string;      // 'YYYY-MM-DD' — the 1st of the month
  navDate: string;           // actual NAV date used
  nav: number;
  units: number;
  amount: number;
}

export interface PastSipResult {
  installments: PastSipInstallment[];
  totalInvested: number;
  totalUnits: number;
  finalNav: number;
  finalNavDate: string | null;
  currentValue: number;
  gain: number;
  gainPct: number;           // percentage points (e.g. 27.4 means +27.4%)
  xirr: number;              // decimal (e.g. 0.124 = 12.4% p.a.); NaN if it didn't converge
  cashflows: Cashflow[];
  startDate: string | null;  // first installment NAV date used
  endDate: string | null;    // final-value valuation date
  requestedStartDate: string | null;
  shortHistory: boolean;     // true if NAV history is shorter than the requested duration
  hasEnoughData: boolean;    // true if at least 3 installments could be made
}

const MIN_INSTALLMENTS = 3;

const EMPTY_RESULT: PastSipResult = {
  installments: [],
  totalInvested: 0,
  totalUnits: 0,
  finalNav: 0,
  finalNavDate: null,
  currentValue: 0,
  gain: 0,
  gainPct: 0,
  xirr: NaN,
  cashflows: [],
  startDate: null,
  endDate: null,
  requestedStartDate: null,
  shortHistory: false,
  hasEnoughData: false,
};

export function durationToYears(duration: PastSipDuration): number | null {
  switch (duration) {
    case '1Y': return 1;
    case '3Y': return 3;
    case '5Y': return 5;
    case 'All': return null;
  }
}

function toDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map((p) => parseInt(p, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function firstOfMonthStr(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Returns the requested SIP start date for the given duration relative to today.
 * For 'All', returns null — caller falls back to the first NAV date.
 */
export function computeRequestedStartDate(
  duration: PastSipDuration,
  today: Date,
): string | null {
  const years = durationToYears(duration);
  if (years === null) return null;
  // Anchor to the 1st of the month so the SIP window is whole months
  const start = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), 1));
  return toDateStr(start);
}

/**
 * Find the first NAV row on or after the given date string.
 * Linear scan from `cursor`; returns the index at which the lookup succeeded
 * so subsequent calls can resume without re-scanning the prefix.
 */
function findNavOnOrAfter(
  series: NavPoint[],
  date: string,
  cursor: number,
): { index: number; point: NavPoint } | null {
  for (let i = cursor; i < series.length; i++) {
    if (series[i].date >= date) return { index: i, point: series[i] };
  }
  return null;
}

export function simulatePastSip(input: PastSipInput): PastSipResult {
  const { navSeries, monthlyAmount, duration } = input;
  const today = input.today ?? new Date();

  if (navSeries.length === 0 || monthlyAmount <= 0) {
    return { ...EMPTY_RESULT };
  }

  const requestedStart = computeRequestedStartDate(duration, today);
  const seriesFirstDate = navSeries[0].date;
  const effectiveStartStr = requestedStart && requestedStart > seriesFirstDate
    ? requestedStart
    : seriesFirstDate;

  // Anchor to the 1st of the month containing effectiveStartStr
  const effectiveStartDate = parseDateStr(effectiveStartStr);
  let installmentYear = effectiveStartDate.getUTCFullYear();
  let installmentMonth = effectiveStartDate.getUTCMonth() + 1; // 1–12

  // Latest NAV serves as today's valuation.
  const finalNavRow = navSeries[navSeries.length - 1];
  const finalNavDateStr = finalNavRow.date;
  const finalNav = finalNavRow.value;
  const todayStr = toDateStr(today);
  // Cap installment loop at min(today, finalNavDate) so we don't try to "buy"
  // in months past the latest NAV row.
  const lastInstallmentDateStr = finalNavDateStr < todayStr ? finalNavDateStr : todayStr;

  const installments: PastSipInstallment[] = [];
  let totalUnits = 0;
  let totalInvested = 0;
  let cursor = 0;

  while (true) {
    const intended = firstOfMonthStr(installmentYear, installmentMonth);
    if (intended > lastInstallmentDateStr) break;

    const lookup = findNavOnOrAfter(navSeries, intended, cursor);
    if (!lookup) break;
    cursor = lookup.index;

    const nav = lookup.point.value;
    if (nav > 0) {
      const units = monthlyAmount / nav;
      installments.push({
        intendedDate: intended,
        navDate: lookup.point.date,
        nav,
        units,
        amount: monthlyAmount,
      });
      totalUnits += units;
      totalInvested += monthlyAmount;
    }

    installmentMonth += 1;
    if (installmentMonth > 12) {
      installmentMonth = 1;
      installmentYear += 1;
    }
  }

  if (installments.length === 0) {
    return {
      ...EMPTY_RESULT,
      requestedStartDate: requestedStart,
      finalNav,
      finalNavDate: finalNavDateStr,
    };
  }

  const currentValue = totalUnits * finalNav;
  const gain = currentValue - totalInvested;
  const gainPct = totalInvested > 0 ? (gain / totalInvested) * 100 : 0;

  const cashflows: Cashflow[] = installments.map((i) => ({
    date: parseDateStr(i.navDate),
    amount: -i.amount,
  }));
  cashflows.push({ date: parseDateStr(finalNavDateStr), amount: currentValue });

  let computedXirr = NaN;
  try {
    computedXirr = xirr(cashflows);
  } catch {
    computedXirr = NaN;
  }

  const startDate = installments[0].navDate;
  // shortHistory flips true when the first installment's intended month is
  // later than the requested start month — i.e. the fund didn't have enough
  // history to cover the asked-for window.
  const shortHistory =
    requestedStart !== null && installments[0].intendedDate > requestedStart;

  return {
    installments,
    totalInvested,
    totalUnits,
    finalNav,
    finalNavDate: finalNavDateStr,
    currentValue,
    gain,
    gainPct,
    xirr: computedXirr,
    cashflows,
    startDate,
    endDate: finalNavDateStr,
    requestedStartDate: requestedStart,
    shortHistory,
    hasEnoughData: installments.length >= MIN_INSTALLMENTS,
  };
}

export interface PastSipChartPoint {
  date: string;
  invested: number;
  fundValue: number;
  benchmarkValue: number | null;
}

/**
 * Build a sampled chart-ready series for fund vs benchmark vs invested.
 *
 * Both the fund and the benchmark are simulated independently using the same
 * monthly cadence (1st of month NAV). For each installment date we record:
 *  - cumulative invested
 *  - fund value at that NAV (units accumulated × NAV)
 *  - benchmark value (units accumulated in the benchmark × benchmark NAV)
 *
 * The benchmark value is null at any point where benchmark NAV is unavailable
 * for the fund's installment date.
 *
 * Limits the output to ~60 points for render performance.
 */
export function buildPastSipChartSeries(
  fundResult: PastSipResult,
  benchmarkResult: PastSipResult | null,
): PastSipChartPoint[] {
  if (fundResult.installments.length === 0) return [];

  const benchByDate = new Map<string, { value: number; cumulativeUnits: number }>();
  if (benchmarkResult) {
    let units = 0;
    for (const inst of benchmarkResult.installments) {
      units += inst.units;
      benchByDate.set(inst.intendedDate, { value: units * inst.nav, cumulativeUnits: units });
    }
  }

  const points: PastSipChartPoint[] = [];
  let fundUnits = 0;
  let invested = 0;
  for (const inst of fundResult.installments) {
    fundUnits += inst.units;
    invested += inst.amount;
    const fundValueHere = fundUnits * inst.nav;
    const benchSnapshot = benchByDate.get(inst.intendedDate);
    points.push({
      date: inst.intendedDate,
      invested,
      fundValue: fundValueHere,
      benchmarkValue: benchSnapshot ? benchSnapshot.value : null,
    });
  }

  // Always anchor the final point to the latest NAV used for valuation.
  const last = points[points.length - 1];
  if (fundResult.endDate && last.date !== fundResult.endDate) {
    points.push({
      date: fundResult.endDate,
      invested: fundResult.totalInvested,
      fundValue: fundResult.currentValue,
      benchmarkValue: benchmarkResult ? benchmarkResult.currentValue : null,
    });
  } else {
    points[points.length - 1] = {
      date: last.date,
      invested: fundResult.totalInvested,
      fundValue: fundResult.currentValue,
      benchmarkValue: benchmarkResult ? benchmarkResult.currentValue : last.benchmarkValue,
    };
  }

  // Sample to ≤60 points
  if (points.length <= 60) return points;
  const step = Math.ceil(points.length / 60);
  const sampled: PastSipChartPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i % step === 0 || i === points.length - 1) sampled.push(points[i]);
  }
  return sampled;
}
