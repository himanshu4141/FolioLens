/**
 * Direct vs Regular Impact — pure cost-drag calculation.
 *
 * The screen comparing Direct vs Regular fund plans needs:
 *  1) A way to detect which plan a held fund belongs to (direct / regular /
 *     unknown). AMFI naming convention puts "Direct Plan" or "Regular Plan"
 *     directly into the scheme name; that's how we detect it.
 *  2) A cost-drag projection: given a current corpus + monthly SIP + horizon
 *     + per-year expense-ratio difference, estimate the rupee impact of the
 *     higher expense ratio over the horizon.
 *
 * The math is differential — the absolute "base return" assumption mostly
 * cancels out in the subtraction, so we hold it fixed at 10% p.a. (Balanced)
 * to keep the tool self-contained.
 *
 * Everything here is a pure function. No React, no Supabase.
 */

export type PlanType = 'direct' | 'regular' | 'unknown';

const DIRECT_RX = /\bdirect\s+plan\b/i;
const REGULAR_RX = /\bregular\s+plan\b/i;

/**
 * Detect the plan type from a scheme name. Returns 'unknown' if the name
 * doesn't contain either marker — calling code should treat 'unknown' as
 * "exclude from cost-impact totals" and surface a count separately.
 */
export function detectPlanType(schemeName: string | null | undefined): PlanType {
  if (!schemeName) return 'unknown';
  if (DIRECT_RX.test(schemeName)) return 'direct';
  if (REGULAR_RX.test(schemeName)) return 'regular';
  return 'unknown';
}

export interface CostImpactInput {
  /** Current corpus already invested. */
  currentCorpus: number;
  /** Monthly SIP that will continue for the horizon. */
  monthlySip: number;
  /** Years of horizon. */
  years: number;
  /** Annualised return assumption for the direct plan (e.g. 0.10). */
  directAnnualReturn: number;
  /** The fee delta — regular minus direct, as an annualised decimal (e.g. 0.007 for 70 bps). */
  expenseRatioDelta: number;
}

export interface CostImpactResult {
  /** Future value of the portfolio if held in the direct plan. */
  directFutureValue: number;
  /** Future value if held in the regular plan (lower net return). */
  regularFutureValue: number;
  /** directFutureValue − regularFutureValue. */
  impact: number;
  /** impact as a % of regularFutureValue. */
  impactPct: number;
}

/**
 * Future value of a one-time corpus + a monthly SIP over `years` at an
 * annualised compounded return.
 *
 *   FV(corpus) = corpus × (1 + r)^n
 *   FV(SIP)    = sip × (((1 + rMonthly)^months − 1) / rMonthly)
 */
export function projectFutureValue(
  corpus: number,
  monthlySip: number,
  years: number,
  annualReturn: number,
): number {
  if (years <= 0) return Math.max(0, corpus);
  const months = Math.max(0, Math.round(years * 12));
  const r = annualReturn;
  const rm = Math.pow(1 + r, 1 / 12) - 1;

  const fvCorpus = Math.max(0, corpus) * Math.pow(1 + r, years);
  const fvSip = monthlySip > 0 && rm > 0
    ? monthlySip * ((Math.pow(1 + rm, months) - 1) / rm)
    : monthlySip > 0 ? monthlySip * months : 0;

  return fvCorpus + fvSip;
}

/**
 * Computes the rupee impact of being in the regular plan for `years` years,
 * vs being in the direct plan. The regular plan's net return is
 * `directAnnualReturn − expenseRatioDelta`.
 */
export function computeCostImpact(input: CostImpactInput): CostImpactResult {
  const { currentCorpus, monthlySip, years, directAnnualReturn, expenseRatioDelta } = input;
  const direct = projectFutureValue(currentCorpus, monthlySip, years, directAnnualReturn);
  const regularReturn = Math.max(-0.99, directAnnualReturn - expenseRatioDelta);
  const regular = projectFutureValue(currentCorpus, monthlySip, years, regularReturn);
  const impact = direct - regular;
  const impactPct = regular > 0 ? (impact / regular) * 100 : 0;
  return {
    directFutureValue: direct,
    regularFutureValue: regular,
    impact,
    impactPct,
  };
}

export interface FundPlanRow {
  /** A unique key for the fund — used only for caller-side identity, not by this util. */
  id: string;
  schemeName: string;
  /** Caller-supplied if known; otherwise we'll fall back to detectPlanType. */
  planType?: PlanType;
  /** Current invested corpus or current value (caller's choice — typically current value). */
  currentValue: number;
  expenseRatio?: number | null;
}

export interface PlanBreakdown {
  /** Funds bucketed by detected plan type. */
  direct: FundPlanRow[];
  regular: FundPlanRow[];
  unknown: FundPlanRow[];
  /** Sum of currentValue across direct funds. */
  directValue: number;
  /** Sum of currentValue across regular funds. */
  regularValue: number;
  /** Sum of currentValue across unknown funds. */
  unknownValue: number;
  /** Total currentValue across all funds (direct + regular + unknown). */
  totalValue: number;
  /** Weighted-average expense ratio across funds with a known expenseRatio. */
  weightedExpenseRatio: number | null;
}

// ---------------------------------------------------------------------------
// Per-fund drag computation (personalized path)
// ---------------------------------------------------------------------------

/**
 * How the direct-plan counterpart ER was obtained for a given regular fund.
 * Surfaced in the "See the assumptions" reveal so users can see data provenance.
 */
export type DirectErSource = 'sibling-lookup' | 'category-constant' | 'flat-fallback';

/** Input for a single regular fund's drag computation. */
export interface FundDragInput {
  fund: FundPlanRow;
  /** Estimated direct-plan expense ratio for the same fund, in % (e.g. 0.68). */
  directEr: number;
  directErSource: DirectErSource;
}

/** Per-fund drag result returned by `computeFundDrags`. */
export interface FundDragResult {
  fund: FundPlanRow;
  /** The fund's own expense ratio (%). Mirrors fund.expenseRatio for convenience. */
  regularEr: number;
  directEr: number;
  /** (regularEr - directEr) / 100, clamped to [0, ∞). */
  deltaDecimal: number;
  directErSource: DirectErSource;
  /** Future value the fund would reach in a direct plan over `years`. */
  directFutureValue: number;
  /** Future value the fund reaches in the regular plan over `years`. */
  regularFutureValue: number;
  /** directFutureValue − regularFutureValue (rupee cost of the fee gap). */
  drag: number;
}

/**
 * Compute the rupee drag for each regular-plan fund from its own ER delta,
 * on a holdings-only basis (SIP = 0 — the honest personal number for what
 * the user already holds). Base return is fixed at 10% p.a. for consistency.
 *
 * Funds with `expenseRatio == null` should be excluded by the caller; this
 * function falls back safely (deltaDecimal = 0) if ER is missing.
 */
export function computeFundDrags(
  inputs: FundDragInput[],
  years: number,
): FundDragResult[] {
  return inputs.map(({ fund, directEr, directErSource }) => {
    const regularEr = fund.expenseRatio ?? directEr;
    const deltaDecimal = Math.max(0, (regularEr - directEr) / 100);
    const result = computeCostImpact({
      currentCorpus: fund.currentValue,
      monthlySip: 0,
      years,
      directAnnualReturn: 0.10,
      expenseRatioDelta: deltaDecimal,
    });
    return {
      fund,
      regularEr,
      directEr,
      deltaDecimal,
      directErSource,
      directFutureValue: result.directFutureValue,
      regularFutureValue: result.regularFutureValue,
      drag: result.impact,
    };
  });
}

/**
 * Value-weighted average fee gap (in %) across computed drag results.
 * Returns null when there are no results with positive currentValue.
 */
export function weightedFeeGapPct(drags: FundDragResult[]): number | null {
  const items = drags.filter((d) => d.fund.currentValue > 0);
  if (items.length === 0) return null;
  const totalValue = items.reduce((s, d) => s + d.fund.currentValue, 0);
  if (totalValue === 0) return null;
  return (
    items.reduce((s, d) => s + d.deltaDecimal * 100 * d.fund.currentValue, 0) /
    totalValue
  );
}

// ---------------------------------------------------------------------------

export function buildPlanBreakdown(funds: FundPlanRow[]): PlanBreakdown {
  const direct: FundPlanRow[] = [];
  const regular: FundPlanRow[] = [];
  const unknown: FundPlanRow[] = [];
  let directValue = 0;
  let regularValue = 0;
  let unknownValue = 0;

  for (const fund of funds) {
    const planType = fund.planType ?? detectPlanType(fund.schemeName);
    const value = Number.isFinite(fund.currentValue) ? Math.max(0, fund.currentValue) : 0;
    if (planType === 'direct') { direct.push(fund); directValue += value; }
    else if (planType === 'regular') { regular.push(fund); regularValue += value; }
    else { unknown.push(fund); unknownValue += value; }
  }

  let totalEr = 0;
  let totalErWeight = 0;
  for (const fund of funds) {
    if (fund.expenseRatio == null || !Number.isFinite(fund.expenseRatio)) continue;
    const weight = Math.max(0, fund.currentValue);
    totalEr += fund.expenseRatio * weight;
    totalErWeight += weight;
  }
  const weightedExpenseRatio = totalErWeight > 0 ? totalEr / totalErWeight : null;

  return {
    direct,
    regular,
    unknown,
    directValue,
    regularValue,
    unknownValue,
    totalValue: directValue + regularValue + unknownValue,
    weightedExpenseRatio,
  };
}
