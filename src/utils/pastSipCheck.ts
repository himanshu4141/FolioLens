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
  /**
   * Optional fund result to align this simulation to. When set, the simulator
   * skips its own installment-generation loop and instead "buys" on each of
   * the fund result's intended dates, looking up navSeries at-or-before each
   * date. The terminal valuation also moves to the fund's terminal date with
   * at-or-before lookup.
   *
   * This makes a benchmark simulation directly comparable to the fund's —
   * same calendar, same terminal date — so the XIRR gap reflects only
   * underlying performance, not timing artefacts. Indian markets occasionally
   * publish on days mutual fund NAVs don't (Diwali muhurat, Budget Saturday)
   * and series-end dates often differ by 1-2 days; both effects compound into
   * a spurious 0.5–1% gap per year if each series chooses its own dates.
   */
  alignToFund?: PastSipResult;
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
 *
 * The window is a whole number of completed months: a 3Y SIP is exactly 36
 * monthly buys, 1Y is 12, 5Y is 60. We anchor the first installment to
 * `(today's month − N years + 1 month)` so today's month is the LAST buy and
 * we don't double-count the boundary month.
 */
export function computeRequestedStartDate(
  duration: PastSipDuration,
  today: Date,
): string | null {
  const years = durationToYears(duration);
  if (years === null) return null;
  // Start one month after today-minus-N-years so the loop produces exactly N×12 buys.
  const start = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth() + 1, 1));
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

/**
 * Find the latest NAV row on or before the given date string.
 * Used for aligning a benchmark sim to the fund's calendar — if the fund
 * bought on Mon Jan 2 we want the benchmark value AT Mon Jan 2, falling back
 * to the closest prior trading day if the benchmark didn't trade then.
 * (You can't "buy" the benchmark at a future date, so on-or-after is wrong
 *  for this case.)
 */
function findNavOnOrBefore(
  series: NavPoint[],
  date: string,
): NavPoint | null {
  let lo = 0;
  let hi = series.length - 1;
  let found: NavPoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      found = series[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function simulatePastSip(input: PastSipInput): PastSipResult {
  const { navSeries, monthlyAmount, duration, alignToFund } = input;
  const today = input.today ?? new Date();

  if (navSeries.length === 0 || monthlyAmount <= 0) {
    return { ...EMPTY_RESULT };
  }

  const requestedStart = computeRequestedStartDate(duration, today);

  let installments: PastSipInstallment[] = [];
  let totalUnits = 0;
  let totalInvested = 0;
  let finalNav: number;
  let finalNavDateStr: string;

  if (alignToFund && alignToFund.installments.length > 0 && alignToFund.endDate) {
    // ── Aligned benchmark mode ──────────────────────────────────────────────
    // For each fund installment, value the benchmark at the SAME date the
    // fund actually bought (its navDate, not its intendedDate). Use on-or-
    // before lookup so a missing date in the benchmark series falls back to
    // the closest prior trading day. Terminal valuation also moves to the
    // fund's terminal date with the same lookup. This eliminates the
    // ~1%/yr spurious gap that arose when each series independently chose
    // its own end-of-window dates.
    for (const fundInstallment of alignToFund.installments) {
      const point = findNavOnOrBefore(navSeries, fundInstallment.navDate);
      if (!point || point.value <= 0) continue;
      const units = monthlyAmount / point.value;
      installments.push({
        intendedDate: fundInstallment.intendedDate,
        navDate: point.date,
        nav: point.value,
        units,
        amount: monthlyAmount,
      });
      totalUnits += units;
      totalInvested += monthlyAmount;
    }
    const terminal = findNavOnOrBefore(navSeries, alignToFund.endDate);
    if (!terminal) {
      // benchmark series doesn't reach the fund's terminal — fall back to its
      // own latest, which is the safest non-NaN behaviour.
      const latest = navSeries[navSeries.length - 1];
      finalNav = latest.value;
      finalNavDateStr = latest.date;
    } else {
      finalNav = terminal.value;
      finalNavDateStr = terminal.date;
    }
  } else {
    // ── Standalone mode (unchanged behaviour) ───────────────────────────────
    const seriesFirstDate = navSeries[0].date;
    const effectiveStartStr = requestedStart && requestedStart > seriesFirstDate
      ? requestedStart
      : seriesFirstDate;

    const effectiveStartDate = parseDateStr(effectiveStartStr);
    let installmentYear = effectiveStartDate.getUTCFullYear();
    let installmentMonth = effectiveStartDate.getUTCMonth() + 1;

    const finalNavRow = navSeries[navSeries.length - 1];
    finalNavDateStr = finalNavRow.date;
    finalNav = finalNavRow.value;
    const todayStr = toDateStr(today);
    const lastInstallmentDateStr = finalNavDateStr < todayStr ? finalNavDateStr : todayStr;

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
