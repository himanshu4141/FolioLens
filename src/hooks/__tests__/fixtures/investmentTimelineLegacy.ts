import { buildXAxisLabels } from '@/src/hooks/usePerformanceTimeline';
import type { FundRef } from '@/src/hooks/usePortfolioTimeline';
import type {
  InvestmentVsBenchmarkPoint,
  RawIdxRow,
  RawNavRow,
  RawTxRow,
} from '@/src/hooks/useInvestmentVsBenchmarkTimeline';
import { filterToWindow, type NavPoint, type TimeWindow } from '@/src/utils/navUtils';
import {
  buildBenchmarkLookup,
  filterReversedTransactionPairs,
  simulateBenchmarkInvestment,
} from '@/src/utils/xirr';

export interface InvestmentTimelineGoldenFixture {
  name: string;
  funds: FundRef[];
  navRows: RawNavRow[];
  txRows: RawTxRow[];
  idxRows: RawIdxRow[];
}

const GOLDEN_FUNDS: FundRef[] = [
  { id: 'fund-a', schemeCode: 100 },
  { id: 'fund-b', schemeCode: 200 },
];

export const INVESTMENT_TIMELINE_GOLDEN_FIXTURES: InvestmentTimelineGoldenFixture[] = [
  {
    name: 'weekends holidays NFO switches redemptions and reversed pairs',
    funds: GOLDEN_FUNDS,
    navRows: [
      ...monthlyRows(100, '2020-01-02', '2026-06-30', 10, 0.08),
      // Fund B is an NFO: its subscription precedes the first available NAV.
      ...monthlyRows(200, '2021-04-12', '2026-06-30', 10, 0.05),
      { scheme_code: 100, nav_date: '2025-12-24', nav: 15.9 },
      { scheme_code: 100, nav_date: '2026-04-02', nav: 16.2 },
      { scheme_code: 100, nav_date: '2026-06-30', nav: 16.5 },
      { scheme_code: 200, nav_date: '2026-06-30', nav: 13.8 },
    ],
    txRows: [
      { fund_id: 'fund-a', transaction_date: '2020-01-04', transaction_type: 'purchase', units: 100, amount: 1000 },
      // Failed-payment reversal pair: same fund/date/amount; zero-unit reversal.
      { fund_id: 'fund-a', transaction_date: '2020-02-10', transaction_type: 'redemption', units: 0, amount: 500 },
      { fund_id: 'fund-a', transaction_date: '2020-02-10', transaction_type: 'purchase', units: 50, amount: 500 },
      // Weekend NFO subscription with no NAV until the following month.
      { fund_id: 'fund-b', transaction_date: '2021-03-06', transaction_type: 'purchase', units: 2000, amount: 20000 },
      { fund_id: 'fund-a', transaction_date: '2023-01-15', transaction_type: 'switch_out', units: 20, amount: 300 },
      { fund_id: 'fund-b', transaction_date: '2023-01-15', transaction_type: 'switch_in', units: 30, amount: 300 },
      { fund_id: 'fund-b', transaction_date: '2024-05-01', transaction_type: 'redemption', units: 100, amount: 1500 },
      // Christmas and Good Friday have no same-day NAV/index row.
      { fund_id: 'fund-a', transaction_date: '2025-12-25', transaction_type: 'dividend_reinvest', units: 5, amount: 100 },
      { fund_id: 'fund-a', transaction_date: '2026-04-03', transaction_type: 'purchase', units: 12, amount: 200 },
      { fund_id: 'fund-a', transaction_date: '2026-06-15', transaction_type: 'redemption', units: 10, amount: 180 },
    ],
    // Monthly observations deliberately do not align with most transaction or
    // NAV dates, exercising latest-at-or-before lookup over holiday gaps.
    idxRows: monthlyIndexRows('2019-12-31', '2026-06-30', 100, 1.1),
  },
  {
    name: 'missing NAV and delayed index coverage',
    funds: GOLDEN_FUNDS,
    navRows: [
      { scheme_code: 100, nav_date: '2020-01-02', nav: 10 },
      { scheme_code: 100, nav_date: '2021-02-05', nav: 12 },
      { scheme_code: 100, nav_date: '2026-06-30', nav: 20 },
      // No NAV rows for fund B: its live position remains marked to cost.
    ],
    txRows: [
      // This investment predates all index data and cannot create benchmark units.
      { fund_id: 'fund-a', transaction_date: '2020-01-04', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'fund-b', transaction_date: '2021-02-06', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'fund-a', transaction_date: '2026-06-01', transaction_type: 'redemption', units: 20, amount: 350 },
    ],
    idxRows: [
      { index_date: '2021-01-29', close_value: 100 },
      { index_date: '2021-02-05', close_value: 105 },
      { index_date: '2026-05-29', close_value: 180 },
      { index_date: '2026-06-30', close_value: 182 },
    ],
  },
];

/**
 * Frozen copy of the production algorithm immediately before N2T.
 *
 * Keep this intentionally unoptimized. Golden tests compare the new split
 * pipeline against this reference so early sampling or cache changes cannot
 * silently change a date or financial value.
 */
export function computeLegacyInvestmentTimeline(
  navRows: RawNavRow[],
  txRows: RawTxRow[],
  idxRows: RawIdxRow[],
  funds: FundRef[],
  window: TimeWindow,
): { points: InvestmentVsBenchmarkPoint[]; xAxisLabels: string[] } {
  if (funds.length === 0 || navRows.length === 0 || txRows.length === 0 || idxRows.length === 0) {
    return { points: [], xAxisLabels: [] };
  }

  const fundIds = new Set(funds.map((fund) => fund.id));
  const navHistoryByScheme = new Map<number, NavPoint[]>();
  const allDates = new Set<string>();
  for (const row of navRows) {
    const existing = navHistoryByScheme.get(row.scheme_code) ?? [];
    existing.push({ date: row.nav_date, value: row.nav });
    navHistoryByScheme.set(row.scheme_code, existing);
    allDates.add(row.nav_date);
  }
  for (const [schemeCode, history] of navHistoryByScheme) {
    navHistoryByScheme.set(
      schemeCode,
      history.sort((a, b) => a.date.localeCompare(b.date)),
    );
  }

  const benchmarkValueAt = buildBenchmarkLookup(
    idxRows.map((row) => ({ date: row.index_date, value: row.close_value })),
  );
  const sortedTransactions = filterReversedTransactionPairs(txRows)
    .filter((tx) => fundIds.has(tx.fund_id))
    .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  const { unitsHistory: benchmarkUnitHistory } = simulateBenchmarkInvestment(
    sortedTransactions,
    benchmarkValueAt,
  );

  const unitHistory = new Map<string, { date: string; units: number }[]>();
  const costHistory = new Map<string, { date: string; cost: number }[]>();
  const investedHistory: { date: string; investedValue: number }[] = [];
  const fundUnits = new Map<string, number>();
  const fundCost = new Map<string, number>();
  let totalInvested = 0;

  for (const fund of funds) {
    unitHistory.set(fund.id, []);
    costHistory.set(fund.id, []);
    fundUnits.set(fund.id, 0);
    fundCost.set(fund.id, 0);
  }

  for (const tx of sortedTransactions) {
    const date = tx.transaction_date;
    const previousUnits = fundUnits.get(tx.fund_id) ?? 0;
    const previousCost = fundCost.get(tx.fund_id) ?? 0;

    if (isInvestment(tx.transaction_type)) {
      fundUnits.set(tx.fund_id, previousUnits + tx.units);
      fundCost.set(tx.fund_id, previousCost + tx.amount);
      totalInvested += tx.amount;
    } else if (isRedemption(tx.transaction_type)) {
      const averageCost = previousUnits > 0 ? previousCost / previousUnits : 0;
      const costBasis = tx.units * averageCost;
      fundUnits.set(tx.fund_id, Math.max(0, previousUnits - tx.units));
      fundCost.set(tx.fund_id, Math.max(0, previousCost - costBasis));
      totalInvested = Math.max(0, totalInvested - costBasis);
    }

    unitHistory.get(tx.fund_id)!.push({ date, units: fundUnits.get(tx.fund_id) ?? 0 });
    costHistory.get(tx.fund_id)!.push({ date, cost: fundCost.get(tx.fund_id) ?? 0 });
    investedHistory.push({ date, investedValue: totalInvested });
    allDates.add(date);
  }

  const rawPoints: InvestmentVsBenchmarkPoint[] = [];
  for (const date of [...allDates].sort()) {
    let portfolioValue = 0;
    let hasPortfolioValue = false;

    for (const fund of funds) {
      const units = Math.max(0, latestAt(unitHistory.get(fund.id) ?? [], date)?.units ?? 0);
      if (units <= 0) continue;
      const navPoint = latestAt(navHistoryByScheme.get(fund.schemeCode) ?? [], date);
      if (navPoint) {
        portfolioValue += units * navPoint.value;
        hasPortfolioValue = true;
        continue;
      }
      const costBasis = Math.max(0, latestAt(costHistory.get(fund.id) ?? [], date)?.cost ?? 0);
      if (costBasis > 0) {
        portfolioValue += costBasis;
        hasPortfolioValue = true;
      }
    }

    const benchmarkClose = benchmarkValueAt(date);
    const simulatedBenchmarkUnits = Math.max(
      0,
      latestAt(benchmarkUnitHistory, date)?.units ?? 0,
    );
    const investedValue = Math.max(
      0,
      latestAt(investedHistory, date)?.investedValue ?? 0,
    );

    if (
      hasPortfolioValue &&
      portfolioValue > 0 &&
      investedValue > 0 &&
      benchmarkClose !== null &&
      simulatedBenchmarkUnits > 0
    ) {
      rawPoints.push({
        date,
        investedValue,
        portfolioValue,
        benchmarkValue: simulatedBenchmarkUnits * benchmarkClose,
      });
    }
  }

  const filteredPoints = filterToWindow(
    rawPoints.map((point) => ({ date: point.date, value: point.portfolioValue })),
    window,
  );
  const firstDate = filteredPoints[0]?.date;
  if (!firstDate) return { points: [], xAxisLabels: [] };

  const sampled = sampleLegacyPoints(rawPoints.filter((point) => point.date >= firstDate));
  return {
    points: sampled,
    xAxisLabels: buildXAxisLabels(sampled.map((point) => point.date)),
  };
}

function latestAt<T extends { date: string }>(history: T[], targetDate: string): T | null {
  let lo = 0;
  let hi = history.length - 1;
  let result: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].date <= targetDate) {
      result = history[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function sampleLegacyPoints(
  points: InvestmentVsBenchmarkPoint[],
  maxPoints = 90,
): InvestmentVsBenchmarkPoint[] {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const sampled = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1]?.date !== last.date) sampled.push(last);
  return sampled;
}

function isInvestment(type: string): boolean {
  return type === 'purchase' || type === 'switch_in' || type === 'dividend_reinvest';
}

function isRedemption(type: string): boolean {
  return type === 'redemption' || type === 'switch_out';
}

function monthlyRows(
  schemeCode: number,
  startDate: string,
  endDate: string,
  startingNav: number,
  monthlyIncrement: number,
): RawNavRow[] {
  const rows: RawNavRow[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let index = 0;
  while (cursor <= end) {
    rows.push({
      scheme_code: schemeCode,
      nav_date: cursor.toISOString().slice(0, 10),
      nav: startingNav + index * monthlyIncrement,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    index += 1;
  }
  return rows;
}

function monthlyIndexRows(
  startDate: string,
  endDate: string,
  startingValue: number,
  monthlyIncrement: number,
): RawIdxRow[] {
  const rows: RawIdxRow[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let index = 0;
  while (cursor <= end) {
    rows.push({
      index_date: cursor.toISOString().slice(0, 10),
      close_value: startingValue + index * monthlyIncrement,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    index += 1;
  }
  return rows;
}
