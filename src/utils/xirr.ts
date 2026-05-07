/**
 * XIRR — Extended Internal Rate of Return
 *
 * Computes the annualised return rate for an irregular series of cashflows.
 * Negative amounts = money invested (outflows).
 * Positive amounts = current value or redemptions (inflows).
 *
 * Uses Newton-Raphson iteration. Returns NaN if it fails to converge.
 */

export interface Cashflow {
  date: Date;
  amount: number;
}

const TOLERANCE = 1e-7;
const MAX_ITERATIONS = 1000;

/**
 * Computes XNPV (Net Present Value for irregular cashflows).
 * rate: annualised discount rate
 * flows: cashflows sorted by date
 * origin: the reference date (usually the first cashflow date)
 */
function xnpv(rate: number, flows: Cashflow[], origin: Date): number {
  return flows.reduce((sum, cf) => {
    const years = (cf.date.getTime() - origin.getTime()) / (365.25 * 24 * 3600 * 1000);
    return sum + cf.amount / Math.pow(1 + rate, years);
  }, 0);
}

/**
 * Derivative of XNPV with respect to rate (for Newton-Raphson).
 */
function xnpvDerivative(rate: number, flows: Cashflow[], origin: Date): number {
  return flows.reduce((sum, cf) => {
    const years = (cf.date.getTime() - origin.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (years === 0) return sum;
    return sum - (years * cf.amount) / Math.pow(1 + rate, years + 1);
  }, 0);
}

/**
 * Returns the XIRR as a decimal (e.g. 0.12 = 12% p.a.)
 * Returns NaN if the cashflows are invalid or Newton-Raphson fails to converge.
 */
export function xirr(cashflows: Cashflow[]): number {
  if (cashflows.length < 2) return NaN;

  // Must have at least one positive and one negative cashflow
  const hasPositive = cashflows.some((cf) => cf.amount > 0);
  const hasNegative = cashflows.some((cf) => cf.amount < 0);
  if (!hasPositive || !hasNegative) return NaN;

  const sorted = [...cashflows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const origin = sorted[0].date;

  // Initial guess: 10%
  let rate = 0.1;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const npv = xnpv(rate, sorted, origin);
    const dnpv = xnpvDerivative(rate, sorted, origin);

    if (Math.abs(dnpv) < 1e-10) break;

    const nextRate = rate - npv / dnpv;

    if (Math.abs(nextRate - rate) < TOLERANCE) {
      return nextRate;
    }

    rate = nextRate;

    // Guard against divergence
    if (rate < -0.999 || rate > 100) {
      // Try a different starting guess
      rate = rate < -0.999 ? 0.0 : -0.5;
    }
  }

  // Final check: verify the result is reasonable
  const finalNpv = xnpv(rate, sorted, origin);
  if (Math.abs(finalNpv) > 1) return NaN;

  return rate;
}

/**
 * Formats an XIRR rate as a percentage string.
 * e.g. xirr returns 0.1234 → "12.34%"
 */
export function formatXirr(rate: number, decimals = 2): string {
  if (!isFinite(rate) || isNaN(rate)) return 'N/A';
  return `${(rate * 100).toFixed(decimals)}%`;
}

export interface Transaction {
  fund_id?: string | null;
  transaction_date: string;
  transaction_type: string;
  units: number;
  amount: number;
}

export interface TransactionCashflows {
  /** Historical cashflows derived from transactions (no terminal inflow). */
  historicalCashflows: Cashflow[];
  /** Full XIRR-ready cashflows: historical + terminal inflow at currentDate. */
  xirrCashflows: Cashflow[];
  netUnits: number;
  investedAmount: number;
}

export interface RealizedGains {
  /** Total realized profit/loss from all redemptions (can be negative). */
  realizedGain: number;
  /** Total proceeds from all redemptions. */
  realizedAmount: number;
  /** Total units redeemed across all redemption transactions. */
  redeemedUnits: number;
}

type ReversalPairCandidate = {
  fund_id?: string | null;
  transaction_date: string;
  transaction_type: string;
  units?: number | null;
  amount?: number | null;
};

/**
 * Older imports stored failed-payment reversals as a purchase plus a same-day
 * redemption. Current imports skip reversal rows, but a re-import can still
 * leave behind the old zero-unit redemption after deleting the paired purchase.
 * Treat both shapes as non-portfolio transactions so cancelled allocations
 * cannot leave phantom units, cost basis, or cashflows behind.
 */
export function findReversedTransactionPairIndexes<T extends ReversalPairCandidate>(
  transactions: T[],
): Set<number> {
  const byKey = new Map<string, { purchases: number[]; reversals: number[] }>();

  transactions.forEach((tx, index) => {
    const key = reversalPairKey(tx);
    if (!key) return;

    const bucket = byKey.get(key) ?? { purchases: [], reversals: [] };
    if (isReversalPairPurchase(tx.transaction_type)) {
      bucket.purchases.push(index);
    } else if (isReversalPairRedemption(tx.transaction_type)) {
      bucket.reversals.push(index);
    }
    byKey.set(key, bucket);
  });

  const paired = new Set<number>();
  for (const { purchases, reversals } of byKey.values()) {
    const remainingReversals = [...reversals];
    for (const purchaseIndex of purchases) {
      const reversalIndex = remainingReversals.findIndex((candidateIndex) =>
        unitsCompatible(transactions[purchaseIndex], transactions[candidateIndex]),
      );
      if (reversalIndex === -1) continue;

      paired.add(purchaseIndex);
      paired.add(remainingReversals[reversalIndex]);
      remainingReversals.splice(reversalIndex, 1);
    }
  }

  transactions.forEach((tx, index) => {
    if (isStandaloneZeroUnitReversal(tx)) paired.add(index);
  });

  return paired;
}

export function filterReversedTransactionPairs<T extends ReversalPairCandidate>(
  transactions: T[],
): T[] {
  const paired = findReversedTransactionPairIndexes(transactions);
  // Drop "balance forward" phantoms surfaced by some CAS PDFs where casparser
  // tags a statement-level marker as SWITCH_IN/SWITCH_OUT with units > 0 but
  // amount = 0. The import path filters these at write time, but this
  // defense-in-depth pass keeps any rows already persisted from corrupting
  // netUnits → currentValue → XIRR. amount = 0 on a buy/sell/switch is
  // never a real economic event in our schema.
  return transactions.filter((tx, index) => {
    if (paired.has(index)) return false;
    if (isPhantomZeroAmount(tx)) return false;
    return true;
  });
}

function isPhantomZeroAmount(tx: ReversalPairCandidate): boolean {
  const type = normalizeTransactionType(tx.transaction_type);
  if (type !== 'switch_in' && type !== 'switch_out') return false;
  const units = positiveNumber(tx.units);
  if (units == null) return false;
  return positiveNumber(tx.amount) == null;
}

function isReversalPairPurchase(type: string): boolean {
  return ['purchase', 'purchase_sip', 'sip_purchase'].includes(normalizeTransactionType(type));
}

function isReversalPairRedemption(type: string): boolean {
  return ['redemption', 'reversal', 'reversed', 'cancelled', 'canceled'].includes(
    normalizeTransactionType(type),
  );
}

function isStandaloneZeroUnitReversal(tx: ReversalPairCandidate): boolean {
  return (
    isReversalPairRedemption(tx.transaction_type) &&
    positiveNumber(tx.amount) != null &&
    positiveNumber(tx.units) == null
  );
}

function reversalPairKey(tx: ReversalPairCandidate): string | null {
  const amount = positiveNumber(tx.amount);
  if (amount == null) return null;
  return [
    tx.fund_id ?? '',
    tx.transaction_date,
    amount.toFixed(2),
  ].join('|');
}

function unitsCompatible(a: ReversalPairCandidate, b: ReversalPairCandidate): boolean {
  const aUnits = positiveNumber(a.units);
  const bUnits = positiveNumber(b.units);
  if (aUnits == null || bUnits == null) return true;

  const tolerance = Math.max(0.0001, Math.max(aUnits, bUnits) * 0.000001);
  return Math.abs(aUnits - bUnits) <= tolerance;
}

function positiveNumber(value: number | null | undefined): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.abs(numeric) : null;
}

function normalizeTransactionType(type: string): string {
  return type.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Computes realized gains from a list of fund transactions using the
 * average cost method.
 *
 * On each purchase, the running average cost per unit is updated.
 * On each redemption, gain = proceeds - (units × avg_cost_at_redemption).
 */
export function computeRealizedGains(transactions: Transaction[]): RealizedGains {
  const sorted = filterReversedTransactionPairs(transactions).sort((a, b) =>
    a.transaction_date.localeCompare(b.transaction_date),
  );

  let totalCost = 0;
  let totalUnits = 0;
  let realizedGain = 0;
  let realizedAmount = 0;
  let redeemedUnits = 0;

  for (const tx of sorted) {
    const isOutflow =
      tx.transaction_type === 'purchase' ||
      tx.transaction_type === 'switch_in' ||
      tx.transaction_type === 'dividend_reinvest';
    const isInflow =
      tx.transaction_type === 'redemption' || tx.transaction_type === 'switch_out';

    if (isOutflow) {
      totalUnits += tx.units;
      totalCost += tx.amount;
    } else if (isInflow) {
      const avgCost = totalUnits > 0 ? totalCost / totalUnits : 0;
      const costBasis = tx.units * avgCost;
      realizedGain += tx.amount - costBasis;
      realizedAmount += tx.amount;
      redeemedUnits += tx.units;
      totalCost = Math.max(0, totalCost - costBasis);
      totalUnits = Math.max(0, totalUnits - tx.units);
    }
  }

  return { realizedGain, realizedAmount, redeemedUnits };
}

/**
 * Converts a list of fund transactions into XIRR-ready cashflows.
 *
 * Outflows (purchase, switch_in, dividend_reinvest): negative cashflows.
 * Inflows (redemption, switch_out): positive cashflows.
 *
 * Appends a terminal inflow of `currentValue` on `currentDate` to represent
 * the current portfolio value, making the result directly usable with xirr().
 *
 * Returns both the historical-only cashflows (for aggregating across funds)
 * and the full xirrCashflows (for per-fund XIRR), along with netUnits and
 * investedAmount derived from the transactions.
 *
 * investedAmount is the cost basis of REMAINING units (not lifetime buys).
 * On each redemption the average-cost basis of the sold units is deducted,
 * exactly mirroring the computeRealizedGains logic.
 */
export function buildCashflowsFromTransactions(
  transactions: Transaction[],
  currentValue: number,
  currentDate: Date,
): TransactionCashflows {
  let netUnits = 0;
  let totalCost = 0; // running cost basis — deducted on sells
  const historicalCashflows: Cashflow[] = [];

  for (const tx of filterReversedTransactionPairs(transactions)) {
    const date = new Date(tx.transaction_date);
    const isOutflow =
      tx.transaction_type === 'purchase' ||
      tx.transaction_type === 'switch_in' ||
      tx.transaction_type === 'dividend_reinvest';
    const isInflow =
      tx.transaction_type === 'redemption' || tx.transaction_type === 'switch_out';

    if (isOutflow) {
      netUnits += tx.units;
      totalCost += tx.amount;
      historicalCashflows.push({ date, amount: -tx.amount });
    } else if (isInflow) {
      // Deduct the avg-cost basis of sold units from running cost
      const avgCost = netUnits > 0 ? totalCost / netUnits : 0;
      const costBasis = tx.units * avgCost;
      totalCost = Math.max(0, totalCost - costBasis);
      netUnits = Math.max(0, netUnits - tx.units);
      historicalCashflows.push({ date, amount: tx.amount });
    }
  }

  const xirrCashflows: Cashflow[] = [
    ...historicalCashflows,
    { date: currentDate, amount: currentValue },
  ];

  return { historicalCashflows, xirrCashflows, netUnits, investedAmount: totalCost };
}

// ---------------------------------------------------------------------------
// Benchmark "what if I'd invested the same in the index" simulation
// ---------------------------------------------------------------------------

export interface BenchmarkValuePoint {
  date: string;
  value: number;
}

export interface BenchmarkSimulation {
  /**
   * Cashflows mirroring the user's investing pattern in the benchmark:
   * negative on each purchase, positive on each redemption — feed straight
   * into xirr() with a terminal inflow appended.
   */
  benchmarkFlows: Cashflow[];
  /** Per-transaction running snapshot of simulated benchmark units held. */
  unitsHistory: { date: string; units: number }[];
  /** Final units held after all transactions — for terminal valuation. */
  finalUnits: number;
}

/**
 * Returns a "latest-at-or-before" lookup over a benchmark series. Transactions
 * on weekends/holidays resolve to the prior trading day's close — matching
 * how a real buy/sell on those dates would clear. Returns null when the date
 * predates the entire series (no benchmark history yet).
 *
 * Input rows do not need to be sorted; the helper sorts internally.
 */
export function buildBenchmarkLookup(
  rows: BenchmarkValuePoint[],
): (date: string) => number | null {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  return (date: string): number | null => {
    let lo = 0;
    let hi = sorted.length - 1;
    let found: BenchmarkValuePoint | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].date <= date) {
        found = sorted[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found?.value ?? null;
  };
}

/**
 * Simulates investing the same amounts on the same dates in a benchmark index.
 * Single source of truth for the "vs benchmark" math used by both the
 * investment-vs-benchmark chart (terminal value) and the portfolio-level
 * marketXirr (annualised return) — keeping the chart line and the headline
 * alpha % consistent for the same inputs.
 */
export function simulateBenchmarkInvestment(
  transactions: Transaction[],
  benchmarkValueAt: (date: string) => number | null,
): BenchmarkSimulation {
  let units = 0;
  const benchmarkFlows: Cashflow[] = [];
  const unitsHistory: { date: string; units: number }[] = [];

  for (const tx of filterReversedTransactionPairs(transactions)) {
    const close = benchmarkValueAt(tx.transaction_date);
    if (close == null || close <= 0) continue;

    const date = new Date(tx.transaction_date);
    const isOutflow =
      tx.transaction_type === 'purchase' ||
      tx.transaction_type === 'switch_in' ||
      tx.transaction_type === 'dividend_reinvest';
    const isInflow =
      tx.transaction_type === 'redemption' || tx.transaction_type === 'switch_out';

    if (isOutflow) {
      units += tx.amount / close;
      benchmarkFlows.push({ date, amount: -tx.amount });
    } else if (isInflow) {
      units = Math.max(0, units - tx.amount / close);
      benchmarkFlows.push({ date, amount: tx.amount });
    } else {
      continue;
    }

    unitsHistory.push({ date: tx.transaction_date, units });
  }

  return { benchmarkFlows, unitsHistory, finalUnits: units };
}

// ---------------------------------------------------------------------------
// computeBenchmarkXirr — canonical primitive for "fund-vs-index" XIRR
// ---------------------------------------------------------------------------

export interface BenchmarkXirrInput {
  /** The user's actual fund transactions (purchase / switch / redemption). */
  transactions: Transaction[];
  /** Latest-at-or-before benchmark lookup. Build via buildBenchmarkLookup(). */
  benchmarkValueAt: (date: string) => number | null;
  /**
   * The date at which the simulated benchmark holding is valued for the
   * terminal cashflow. The CALLER picks this — it MUST match the date used
   * for the fund's portfolio terminal value, otherwise fund and benchmark
   * XIRR aren't directly comparable. Use `today` (with at-or-before lookup)
   * for headline alpha numbers; use the user's fund-NAV-asof date if you're
   * pricing both on that snapshot.
   */
  terminalDate: Date;
}

export interface BenchmarkXirrResult {
  /** XIRR of "the same investing pattern executed in the benchmark", or
   * NaN if the inputs aren't sufficient (no usable terminal value, no
   * outflows, etc.). */
  xirr: number;
  /** The full set of cashflows used for the XIRR. */
  flows: Cashflow[];
  /** Simulated benchmark units held at terminalDate. */
  finalUnits: number;
  /** finalUnits × benchmark close at-or-before terminalDate. */
  finalValue: number;
}

/**
 * Single-call "what return would I have got investing the same money in the
 * index" computation. Bundles the simulator + terminal-flow construction +
 * xirr() so callers can't accidentally mismatch terminal dates between fund
 * XIRR and benchmark XIRR — that asymmetry is the source of past
 * spurious-gap bugs.
 *
 * Returns NaN xirr (with finalValue = 0) when:
 *  - no transactions produce a valid outflow into the benchmark, or
 *  - the benchmark series doesn't reach terminalDate, or
 *  - cashflows lack both signs (xirr requires at least one positive and one
 *    negative).
 */
export function computeBenchmarkXirr(input: BenchmarkXirrInput): BenchmarkXirrResult {
  const { transactions, benchmarkValueAt, terminalDate } = input;
  const sim = simulateBenchmarkInvestment(transactions, benchmarkValueAt);
  const terminalDateStr = terminalDate.toISOString().split('T')[0];
  const terminalClose = benchmarkValueAt(terminalDateStr);

  if (
    sim.finalUnits <= 0 ||
    sim.benchmarkFlows.length === 0 ||
    terminalClose == null ||
    terminalClose <= 0
  ) {
    return { xirr: NaN, flows: sim.benchmarkFlows, finalUnits: sim.finalUnits, finalValue: 0 };
  }

  const finalValue = sim.finalUnits * terminalClose;
  const flows: Cashflow[] = [
    ...sim.benchmarkFlows,
    { date: terminalDate, amount: finalValue },
  ];
  return { xirr: xirr(flows), flows, finalUnits: sim.finalUnits, finalValue };
}
