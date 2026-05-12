/**
 * Read-only fixtures powering "Preview the app" mode.
 *
 * The numbers here are intentionally realistic — they should look like
 * a believable 3-year portfolio of an Indian retail investor — but they
 * are entirely synthetic and deterministic.
 *
 * Architecture: the transaction stream (`PREVIEW_RAW_TRANSACTIONS`) is
 * the source of truth. Every per-fund "current value" / "invested" /
 * "realized" number is *derived* from the stream so Money Trail,
 * Portfolio, and Fund Detail can't drift out of sync. Changes to the
 * stream automatically flow into every downstream surface.
 *
 * Consumed by:
 *  - usePortfolio (returns PREVIEW_FUND_CARDS + PREVIEW_PORTFOLIO_SUMMARY)
 *  - useFundDetail (matches by id, returns the single fund + nav history)
 *  - useMoneyTrail (returns PREVIEW_MONEY_TRAIL)
 */

import type { FundCardData, PortfolioSummary } from '@/src/hooks/usePortfolio';
import type { FundDetailData } from '@/src/hooks/useFundDetail';
import type { MoneyTrailData } from '@/src/hooks/useMoneyTrail';
import type { FundPortfolioComposition } from '@/src/types/app';
import {
  buildAnnualMoneyFlows,
  buildMoneyTrailSummary,
  buildMoneyTrailTransactions,
  getUniqueAmcOptions,
  getUniqueFundOptions,
  type RawMoneyTrailTransaction,
} from '@/src/utils/moneyTrail';

export const PREVIEW_USER_ID = 'preview-user';
// Pin "today" so the demo is identical regardless of clock skew. NAV history
// and transaction dates both anchor to this date.
const PREVIEW_TODAY = new Date('2026-05-09');

function makeNavHistory30d(currentNav: number, schemeCode: number): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const today = PREVIEW_TODAY;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const t = (29 - i) / 29;
    const base = currentNav * (1 - 0.035 * (1 - t));
    const noise = Math.sin((schemeCode + i) * 1.7) * (currentNav * 0.004);
    out.push({ date: d.toISOString().split('T')[0], value: Math.round((base + noise) * 100) / 100 });
  }
  return out;
}

// ── Fund scheme metadata ─────────────────────────────────────────────────────
//
// Only the bits that *don't* depend on the transaction stream live here.
// Financial totals (invested, units, realized) are computed from the
// transactions below so the two can't drift apart.

interface PreviewSchemeMeta {
  id: string;
  schemeName: string;
  schemeCategory: string;
  schemeCode: number;
  currentNav: number;
  previousNav: number;
  returnXirr: number;
}

const SCHEMES: PreviewSchemeMeta[] = [
  {
    id: 'preview-fund-1',
    schemeName: 'Parag Parikh Flexi Cap Fund — Direct Growth',
    schemeCategory: 'Flexi Cap',
    schemeCode: 122639,
    currentNav: 84.21,
    previousNav: 83.55,
    returnXirr: 0.182,
  },
  {
    // Regular plan — included to show the "you have an expensive regular
    // fund" pattern that real onboarded users often discover after import.
    id: 'preview-fund-2',
    schemeName: 'Mirae Asset Large Cap Fund — Regular Growth',
    schemeCategory: 'Large Cap',
    schemeCode: 100016,
    currentNav: 108.74,
    previousNav: 108.18,
    returnXirr: 0.119,
  },
  {
    id: 'preview-fund-3',
    schemeName: 'HDFC Mid-Cap Opportunities Fund — Direct Growth',
    schemeCategory: 'Mid Cap',
    schemeCode: 118989,
    currentNav: 168.55,
    previousNav: 169.92,
    returnXirr: 0.214,
  },
  {
    // Hybrid fund with IDCW Reinvestment plan — the natural home for the
    // dividend_reinvestment transactions in this preview. Hybrid funds
    // declare IDCW more often than pure equity, so this reads as realistic.
    id: 'preview-fund-4',
    schemeName: 'HDFC Hybrid Equity Fund — Direct IDCW Reinvestment',
    schemeCategory: 'Aggressive Hybrid Fund',
    schemeCode: 118566,
    currentNav: 79.45,
    previousNav: 79.18,
    returnXirr: 0.151,
  },
  {
    id: 'preview-fund-5',
    schemeName: 'ICICI Prudential Liquid Fund — Direct Growth',
    schemeCategory: 'Liquid',
    schemeCode: 120186,
    currentNav: 358.27,
    previousNav: 358.18,
    returnXirr: 0.069,
  },
];

const SCHEME_BY_ID = new Map(SCHEMES.map((s) => [s.id, s] as const));

// ── Transaction stream builder ───────────────────────────────────────────────
//
// Each fund declares a list of "events" — SIPs (sequence over months),
// optional redemption, optional dividend reinvestments, optional switch
// in/out. The builder turns these into RawMoneyTrailTransaction rows.

const SIP_MONTHS = 24;

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function monthsAgoDate(monthsAgo: number, day: number): Date {
  const d = new Date(PREVIEW_TODAY);
  d.setMonth(PREVIEW_TODAY.getMonth() - monthsAgo);
  d.setDate(day);
  return d;
}

function deriveAmcName(schemeName: string): string {
  const cleaned = schemeName.split('—')[0].trim();
  const words = cleaned.split(/\s+/);
  if (words.length >= 2 && /^(asset|parikh)$/i.test(words[1])) {
    return `${words[0]} ${words[1]}`;
  }
  return words[0] ?? schemeName;
}

interface BaseRow {
  id: string;
  scheme: PreviewSchemeMeta;
  date: Date;
  type: 'sip_purchase' | 'redemption' | 'switch_in' | 'switch_out' | 'dividend_reinvestment';
  units: number; // signed: positive in, negative out
  amount: number; // signed: positive in (or out for redemption — see below)
  nav: number;
}

function toRawRow(r: BaseRow): RawMoneyTrailTransaction {
  return {
    id: r.id,
    fund_id: r.scheme.id,
    fund_name: r.scheme.schemeName,
    scheme_category: r.scheme.schemeCategory,
    amc_name: deriveAmcName(r.scheme.schemeName),
    transaction_date: isoDate(r.date),
    transaction_type: r.type,
    units: r.units,
    amount: r.amount,
    nav_at_transaction: r.nav,
    folio_number: `${r.scheme.schemeCode % 100000}/${r.scheme.id.slice(-2).toUpperCase()}`,
    cas_import_id: 'preview-import',
    created_at: `${isoDate(r.date)}T10:00:00.000Z`,
  };
}

/**
 * Generates the SIP backbone for a fund: 24 monthly purchases on the 5th,
 * with NAV walking linearly from 80% → 100% of currentNav so the journey
 * looks like a growing equity fund. Returns SIP rows only (no redemptions
 * or other events).
 */
function makeSips(scheme: PreviewSchemeMeta, monthlyAmount: number): BaseRow[] {
  const out: BaseRow[] = [];
  for (let i = 0; i < SIP_MONTHS; i++) {
    const monthsAgo = SIP_MONTHS - 1 - i;
    const navProgress = i / Math.max(1, SIP_MONTHS - 1);
    const navAtTx = Math.round(scheme.currentNav * (0.8 + 0.2 * navProgress) * 100) / 100;
    const units = Math.round((monthlyAmount / navAtTx) * 1000) / 1000;
    out.push({
      id: `preview-tx-${scheme.id}-sip-${i}`,
      scheme,
      date: monthsAgoDate(monthsAgo, 5),
      type: 'sip_purchase',
      units,
      amount: monthlyAmount,
      nav: navAtTx,
    });
  }
  return out;
}

function buildAllTransactions(): RawMoneyTrailTransaction[] {
  const fund1 = SCHEME_BY_ID.get('preview-fund-1')!; // PPFC
  const fund2 = SCHEME_BY_ID.get('preview-fund-2')!; // Mirae Regular
  const fund3 = SCHEME_BY_ID.get('preview-fund-3')!; // HDFC Mid-Cap
  const fund4 = SCHEME_BY_ID.get('preview-fund-4')!; // HDFC Hybrid Equity IDCW
  const fund5 = SCHEME_BY_ID.get('preview-fund-5')!; // ICICI Liquid

  const events: BaseRow[] = [];

  // Fund 1 — Parag Parikh Flexi Cap. Steady SIP, no withdrawals.
  events.push(...makeSips(fund1, 15000));

  // Fund 2 — Mirae Regular. SIP + a partial redemption mid-stream
  // (the "I withdrew some to fund a milestone" pattern).
  events.push(...makeSips(fund2, 10000));
  {
    const navAtRedemption = Math.round(fund2.currentNav * 0.92 * 100) / 100;
    const redemptionUnits = Math.round((30000 / navAtRedemption) * 1000) / 1000;
    events.push({
      id: `preview-tx-${fund2.id}-redeem`,
      scheme: fund2,
      date: monthsAgoDate(8, 18),
      type: 'redemption',
      units: -redemptionUnits,
      amount: -30000,
      nav: navAtRedemption,
    });
  }

  // Fund 3 — HDFC Mid-Cap. SIP + a "switch-out into the hybrid" + a
  // standalone redemption (booked some gain).
  events.push(...makeSips(fund3, 12500));
  {
    // Switch-out at month -10: ₹40k moves from HDFC Mid-Cap into the
    // HDFC Hybrid Equity scheme below. Real CAS reports model this as a
    // pair of switch_out / switch_in rows on the same date.
    const switchDate = monthsAgoDate(10, 12);
    const navOut = Math.round(fund3.currentNav * 0.86 * 100) / 100;
    const unitsOut = Math.round((40000 / navOut) * 1000) / 1000;
    events.push({
      id: `preview-tx-${fund3.id}-switch-out`,
      scheme: fund3,
      date: switchDate,
      type: 'switch_out',
      units: -unitsOut,
      amount: -40000,
      nav: navOut,
    });
    const navIn = Math.round(fund4.currentNav * 0.86 * 100) / 100;
    const unitsIn = Math.round((40000 / navIn) * 1000) / 1000;
    events.push({
      id: `preview-tx-${fund4.id}-switch-in`,
      scheme: fund4,
      date: switchDate,
      type: 'switch_in',
      units: unitsIn,
      amount: 40000,
      nav: navIn,
    });
  }
  {
    // Standalone redemption at month -4 (the existing "booked some
    // realized gain" line).
    const navAtRedemption = Math.round(fund3.currentNav * 0.99 * 100) / 100;
    const redemptionUnits = Math.round((60000 / navAtRedemption) * 1000) / 1000;
    events.push({
      id: `preview-tx-${fund3.id}-redeem`,
      scheme: fund3,
      date: monthsAgoDate(4, 20),
      type: 'redemption',
      units: -redemptionUnits,
      amount: -60000,
      nav: navAtRedemption,
    });
  }

  // Fund 4 — HDFC Hybrid Equity Fund — IDCW Reinvestment. SIPs +
  // quarterly IDCW reinvestments (each adds units; the "amount" mirrors
  // the dividend value the AMC declared per unit).
  events.push(...makeSips(fund4, 6000));
  {
    // Four IDCW reinvestments spread over the SIP window. Per CAS,
    // reinvested IDCW shows up as an inflow row but doesn't increase
    // cost basis — Money Trail treats it as "internal movement".
    const idcwSchedule: { monthsAgo: number; amount: number }[] = [
      { monthsAgo: 20, amount: 1800 },
      { monthsAgo: 14, amount: 2100 },
      { monthsAgo: 8, amount: 2300 },
      { monthsAgo: 2, amount: 2500 },
    ];
    idcwSchedule.forEach((entry, idx) => {
      const navAtPayout = Math.round(fund4.currentNav * (0.82 + idx * 0.04) * 100) / 100;
      const units = Math.round((entry.amount / navAtPayout) * 1000) / 1000;
      events.push({
        id: `preview-tx-${fund4.id}-idcw-${idx}`,
        scheme: fund4,
        date: monthsAgoDate(entry.monthsAgo, 22),
        type: 'dividend_reinvestment',
        units,
        amount: entry.amount,
        nav: navAtPayout,
      });
    });
  }

  // Fund 5 — ICICI Liquid. Pure SIP into a parking fund.
  events.push(...makeSips(fund5, 6666));

  return events.map(toRawRow);
}

const PREVIEW_RAW_TRANSACTIONS: RawMoneyTrailTransaction[] = buildAllTransactions();

// ── Per-fund aggregates derived from the transaction stream ─────────────────
//
// Walks PREVIEW_RAW_TRANSACTIONS once, folding per-fund:
//   currentUnits     = Σ units (signed; redemptions/switch-outs negative)
//   investedAmount   = Σ positive cash inflows (SIPs + switch-ins; excludes
//                      IDCW reinvestments — they're internal movement and
//                      shouldn't inflate cost basis)
//   redeemedUnits    = Σ |units| of redemption rows (not switch-outs)
//   realizedAmount   = Σ |amount| of redemption rows
//   realizedGain     = redeemedAmount minus the cost basis of the
//                      redeemed units (FIFO-style approximation using
//                      the fund's average buy NAV)

interface FundAggregate {
  currentUnits: number;
  investedAmount: number;
  redeemedUnits: number;
  realizedAmount: number;
  realizedGain: number;
}

function aggregatePerFund(): Map<string, FundAggregate> {
  const out = new Map<string, FundAggregate>();
  // Pass 1: running totals of units bought + cost basis (for avg NAV).
  const buyUnits = new Map<string, number>(); // SIPs + switch-ins
  const buyCost = new Map<string, number>();
  for (const tx of PREVIEW_RAW_TRANSACTIONS) {
    const units = tx.units ?? 0;
    const amount = tx.amount ?? 0;
    if (tx.transaction_type === 'sip_purchase' || tx.transaction_type === 'switch_in') {
      buyUnits.set(tx.fund_id, (buyUnits.get(tx.fund_id) ?? 0) + units);
      buyCost.set(tx.fund_id, (buyCost.get(tx.fund_id) ?? 0) + amount);
    } else if (tx.transaction_type === 'dividend_reinvestment') {
      // Adds units but no cost basis — average NAV is unchanged.
      buyUnits.set(tx.fund_id, (buyUnits.get(tx.fund_id) ?? 0) + units);
    }
  }

  // Pass 2: aggregate the final values.
  for (const tx of PREVIEW_RAW_TRANSACTIONS) {
    const units = tx.units ?? 0;
    const amount = tx.amount ?? 0;
    const existing = out.get(tx.fund_id) ?? {
      currentUnits: 0,
      investedAmount: 0,
      redeemedUnits: 0,
      realizedAmount: 0,
      realizedGain: 0,
    };
    existing.currentUnits = Math.round((existing.currentUnits + units) * 1000) / 1000;
    if (tx.transaction_type === 'sip_purchase' || tx.transaction_type === 'switch_in') {
      existing.investedAmount += amount;
    } else if (tx.transaction_type === 'redemption') {
      const absUnits = Math.abs(units);
      const absAmount = Math.abs(amount);
      existing.redeemedUnits = Math.round((existing.redeemedUnits + absUnits) * 100) / 100;
      existing.realizedAmount += absAmount;
      // Avg buy NAV at this point in the stream — uses cumulative
      // totals from pass 1 as a fair approximation.
      const totalUnitsBought = buyUnits.get(tx.fund_id) ?? 0;
      const totalCost = buyCost.get(tx.fund_id) ?? 0;
      const avgNav = totalUnitsBought > 0 ? totalCost / totalUnitsBought : 0;
      const costOfRedeemed = avgNav * absUnits;
      existing.realizedGain += Math.round((absAmount - costOfRedeemed) * 100) / 100;
    }
    // switch_out + dividend_reinvestment: already handled in currentUnits;
    // no impact on invested / realized (internal movement).
    out.set(tx.fund_id, existing);
  }

  return out;
}

const FUND_AGGREGATES = aggregatePerFund();

function buildFundCard(scheme: PreviewSchemeMeta): FundCardData {
  const agg = FUND_AGGREGATES.get(scheme.id) ?? {
    currentUnits: 0,
    investedAmount: 0,
    redeemedUnits: 0,
    realizedAmount: 0,
    realizedGain: 0,
  };
  const currentValue = Math.round(scheme.currentNav * agg.currentUnits * 100) / 100;
  const dailyChangeAmount =
    Math.round((scheme.currentNav - scheme.previousNav) * agg.currentUnits * 100) / 100;
  const dailyChangePct =
    scheme.previousNav > 0
      ? ((scheme.currentNav - scheme.previousNav) / scheme.previousNav) * 100
      : 0;
  return {
    id: scheme.id,
    schemeName: scheme.schemeName,
    schemeCategory: scheme.schemeCategory,
    schemeCode: scheme.schemeCode,
    currentNav: scheme.currentNav,
    previousNav: scheme.previousNav,
    currentUnits: agg.currentUnits,
    currentValue,
    investedAmount: Math.round(agg.investedAmount * 100) / 100,
    dailyChangeAmount,
    dailyChangePct,
    returnXirr: scheme.returnXirr,
    realizedGain: agg.realizedGain,
    realizedAmount: agg.realizedAmount,
    redeemedUnits: agg.redeemedUnits,
    navHistory30d: makeNavHistory30d(scheme.currentNav, scheme.schemeCode),
  };
}

export const PREVIEW_FUND_CARDS: FundCardData[] = SCHEMES.map(buildFundCard);

const totalValue = PREVIEW_FUND_CARDS.reduce((sum, f) => sum + (f.currentValue ?? 0), 0);
const totalInvested = PREVIEW_FUND_CARDS.reduce((sum, f) => sum + f.investedAmount, 0);
const totalDailyChange = PREVIEW_FUND_CARDS.reduce(
  (sum, f) => sum + (f.dailyChangeAmount ?? 0),
  0,
);

export const PREVIEW_PORTFOLIO_SUMMARY: PortfolioSummary = {
  totalValue,
  totalInvested,
  dailyChangeAmount: totalDailyChange,
  dailyChangePct: totalValue > 0 ? (totalDailyChange / (totalValue - totalDailyChange)) * 100 : 0,
  xirr:
    totalValue > 0
      ? PREVIEW_FUND_CARDS.reduce(
          (sum, f) => sum + f.returnXirr * ((f.currentValue ?? 0) / totalValue),
          0,
        )
      : 0,
  marketXirr: 0.118,
  benchmarkSymbol: '^NSEITRI',
  latestNavDate: '2026-05-09',
};

/**
 * Single-fund detail lookup keyed by `FundCardData.id`. Used by hooks
 * that fetch one scheme — usePortfolio's bulk fetch uses the array
 * above.
 */
export function findPreviewFundById(id: string): FundCardData | undefined {
  return PREVIEW_FUND_CARDS.find((f) => f.id === id);
}

export const PREVIEW_MONEY_TRAIL: MoneyTrailData = (() => {
  const transactions = buildMoneyTrailTransactions(PREVIEW_RAW_TRANSACTIONS);
  return {
    transactions,
    annualFlows: buildAnnualMoneyFlows(transactions),
    summary: buildMoneyTrailSummary(transactions),
    fundOptions: getUniqueFundOptions(transactions),
    amcOptions: getUniqueAmcOptions(transactions),
  };
})();

// ── Fund composition fixtures ────────────────────────────────────────────────
//
// `fund_portfolio_composition` rows the live app would load from Supabase.
// Hand-shaped per fund so Portfolio Insights, the Asset Mix card on
// Portfolio, and Compare Funds asset / sector tabs all render with
// realistic numbers in preview mode (instead of staying stuck on
// "Syncing composition data from AMFI disclosures" forever).

interface SectorWeight {
  [sector: string]: number;
}

interface PreviewCompositionSeed {
  schemeId: string;
  equityPct: number;
  debtPct: number;
  cashPct: number;
  otherPct: number;
  largeCapPct: number;
  midCapPct: number;
  smallCapPct: number;
  sectorAllocation: SectorWeight;
  topHoldings: { name: string; sector: string; pctOfNav: number }[];
}

const COMPOSITION_SEEDS: PreviewCompositionSeed[] = [
  {
    schemeId: 'preview-fund-1', // PPFC Flexi Cap
    equityPct: 65,
    debtPct: 2,
    cashPct: 8,
    otherPct: 25, // overseas equities (PPFC holds US tech)
    largeCapPct: 38,
    midCapPct: 18,
    smallCapPct: 9,
    sectorAllocation: {
      'Financial Services': 22.4,
      'Technology': 18.9,
      'Consumer Cyclical': 11.6,
      'Communication Services': 8.3,
      'Healthcare': 6.1,
      'Industrials': 4.2,
      'Consumer Defensive': 3.7,
    },
    topHoldings: [
      { name: 'HDFC Bank', sector: 'Financial Services', pctOfNav: 8.2 },
      { name: 'Bajaj Holdings', sector: 'Financial Services', pctOfNav: 6.4 },
      { name: 'ITC', sector: 'Consumer Defensive', pctOfNav: 4.9 },
      { name: 'ICICI Bank', sector: 'Financial Services', pctOfNav: 4.6 },
      { name: 'Power Grid', sector: 'Utilities', pctOfNav: 3.8 },
      { name: 'Maruti Suzuki', sector: 'Consumer Cyclical', pctOfNav: 3.2 },
      { name: 'Alphabet Inc', sector: 'Communication Services', pctOfNav: 3.1 },
      { name: 'Meta Platforms', sector: 'Communication Services', pctOfNav: 2.8 },
    ],
  },
  {
    schemeId: 'preview-fund-2', // Mirae Large Cap Regular
    equityPct: 97,
    debtPct: 0,
    cashPct: 3,
    otherPct: 0,
    largeCapPct: 84,
    midCapPct: 11,
    smallCapPct: 2,
    sectorAllocation: {
      'Financial Services': 31.2,
      'Technology': 14.6,
      'Consumer Cyclical': 9.8,
      'Energy': 8.4,
      'Industrials': 7.2,
      'Healthcare': 6.5,
      'Consumer Defensive': 5.9,
    },
    topHoldings: [
      { name: 'HDFC Bank', sector: 'Financial Services', pctOfNav: 9.1 },
      { name: 'ICICI Bank', sector: 'Financial Services', pctOfNav: 8.4 },
      { name: 'Reliance Industries', sector: 'Energy', pctOfNav: 7.8 },
      { name: 'Infosys', sector: 'Technology', pctOfNav: 5.6 },
      { name: 'TCS', sector: 'Technology', pctOfNav: 4.9 },
      { name: 'Larsen & Toubro', sector: 'Industrials', pctOfNav: 3.4 },
      { name: 'Bharti Airtel', sector: 'Communication Services', pctOfNav: 2.9 },
    ],
  },
  {
    schemeId: 'preview-fund-3', // HDFC Mid-Cap Opps
    equityPct: 95,
    debtPct: 0,
    cashPct: 5,
    otherPct: 0,
    largeCapPct: 12,
    midCapPct: 71,
    smallCapPct: 17,
    sectorAllocation: {
      'Financial Services': 18.5,
      'Industrials': 16.2,
      'Consumer Cyclical': 14.1,
      'Healthcare': 12.6,
      'Basic Materials': 9.8,
      'Technology': 7.4,
      'Utilities': 5.3,
    },
    topHoldings: [
      { name: 'Tata Power', sector: 'Utilities', pctOfNav: 4.6 },
      { name: 'Cholamandalam Investment', sector: 'Financial Services', pctOfNav: 4.2 },
      { name: 'Max Healthcare', sector: 'Healthcare', pctOfNav: 3.9 },
      { name: 'Persistent Systems', sector: 'Technology', pctOfNav: 3.6 },
      { name: 'Indian Hotels', sector: 'Consumer Cyclical', pctOfNav: 3.4 },
      { name: 'Coromandel International', sector: 'Basic Materials', pctOfNav: 3.1 },
      { name: 'Ipca Laboratories', sector: 'Healthcare', pctOfNav: 2.8 },
    ],
  },
  {
    schemeId: 'preview-fund-4', // HDFC Hybrid Equity IDCW
    equityPct: 71,
    debtPct: 24,
    cashPct: 5,
    otherPct: 0,
    largeCapPct: 47,
    midCapPct: 19,
    smallCapPct: 5,
    sectorAllocation: {
      'Financial Services': 24.8,
      'Technology': 11.2,
      'Consumer Cyclical': 9.4,
      'Energy': 6.7,
      'Healthcare': 5.9,
      'Industrials': 5.1,
      'Consumer Defensive': 4.4,
    },
    topHoldings: [
      { name: 'HDFC Bank', sector: 'Financial Services', pctOfNav: 7.6 },
      { name: 'ICICI Bank', sector: 'Financial Services', pctOfNav: 6.2 },
      { name: 'Reliance Industries', sector: 'Energy', pctOfNav: 5.4 },
      { name: 'Infosys', sector: 'Technology', pctOfNav: 4.1 },
      { name: 'GOI 7.18% 2033', sector: 'Sovereign', pctOfNav: 8.9 },
      { name: 'GOI 7.10% 2029', sector: 'Sovereign', pctOfNav: 6.3 },
      { name: 'HDB Financial NCD', sector: 'Financial Services', pctOfNav: 3.1 },
    ],
  },
  {
    schemeId: 'preview-fund-5', // ICICI Liquid
    equityPct: 0,
    debtPct: 18,
    cashPct: 82,
    otherPct: 0,
    largeCapPct: 0,
    midCapPct: 0,
    smallCapPct: 0,
    sectorAllocation: {},
    topHoldings: [
      { name: '91-day T-Bill', sector: 'Sovereign', pctOfNav: 22.4 },
      { name: 'Reverse Repo', sector: 'Cash', pctOfNav: 18.6 },
      { name: 'TREPS', sector: 'Cash', pctOfNav: 15.2 },
      { name: 'HDFC Bank CD', sector: 'Financial Services', pctOfNav: 9.8 },
      { name: 'ICICI Bank CD', sector: 'Financial Services', pctOfNav: 7.4 },
    ],
  },
];

const TODAY_ISO = isoDate(PREVIEW_TODAY);

export const PREVIEW_FUND_COMPOSITIONS: FundPortfolioComposition[] = COMPOSITION_SEEDS.map(
  (seed) => {
    const scheme = SCHEME_BY_ID.get(seed.schemeId)!;
    const classifiedCap = seed.largeCapPct + seed.midCapPct + seed.smallCapPct;
    return {
      schemeCode: scheme.schemeCode,
      portfolioDate: TODAY_ISO,
      equityPct: seed.equityPct,
      debtPct: seed.debtPct,
      cashPct: seed.cashPct,
      otherPct: seed.otherPct,
      largeCapPct: seed.largeCapPct,
      midCapPct: seed.midCapPct,
      smallCapPct: seed.smallCapPct,
      notClassifiedPct: Math.max(0, 100 - classifiedCap),
      sectorAllocation: Object.keys(seed.sectorAllocation).length
        ? (seed.sectorAllocation as Record<string, number>)
        : null,
      topHoldings: seed.topHoldings.map((h) => ({
        name: h.name,
        isin: '',
        sector: h.sector,
        marketCap: 'Other',
        pctOfNav: h.pctOfNav,
      })),
      source: 'amfi',
    };
  },
);

const PREVIEW_FUND_COMPOSITION_BY_CODE = new Map(
  PREVIEW_FUND_COMPOSITIONS.map((c) => [c.schemeCode, c] as const),
);

export function findPreviewCompositionByCode(
  schemeCode: number,
): FundPortfolioComposition | undefined {
  return PREVIEW_FUND_COMPOSITION_BY_CODE.get(schemeCode);
}

// ── Fund Detail fixture builder ──────────────────────────────────────────────
//
// Mirrors `FundDetailData`. Built from the same scheme metadata +
// transaction aggregates as the Portfolio card so all three surfaces
// (Portfolio card, Fund Detail header, Money Trail) read coherent
// numbers for the same fund.

export function buildPreviewFundDetail(fundId: string): FundDetailData | null {
  const scheme = SCHEME_BY_ID.get(fundId);
  if (!scheme) return null;
  const agg = FUND_AGGREGATES.get(fundId) ?? {
    currentUnits: 0,
    investedAmount: 0,
    redeemedUnits: 0,
    realizedAmount: 0,
    realizedGain: 0,
  };
  const currentValue = Math.round(scheme.currentNav * agg.currentUnits * 100) / 100;
  // Two-row "navHistory" matches the Fund Detail header card shape.
  const navHistory = [
    { date: isoDate(monthsAgoDate(0, 8)), value: scheme.previousNav },
    { date: isoDate(monthsAgoDate(0, 9)), value: scheme.currentNav },
  ];
  return {
    id: scheme.id,
    schemeName: scheme.schemeName,
    schemeCategory: scheme.schemeCategory,
    schemeCode: scheme.schemeCode,
    benchmarkIndex: null,
    benchmarkSymbol: '^NSEITRI',
    currentNav: scheme.currentNav,
    currentUnits: agg.currentUnits,
    currentValue,
    investedAmount: Math.round(agg.investedAmount * 100) / 100,
    realizedGain: agg.realizedGain,
    realizedAmount: agg.realizedAmount,
    redeemedUnits: agg.redeemedUnits,
    fundXirr: scheme.returnXirr,
    navHistory,
    isin: null,
    expenseRatio: scheme.schemeName.includes('Regular') ? 1.62 : 0.65,
    aumCr: null,
    minSipAmount: 500,
    fundMetaSyncedAt: `${TODAY_ISO}T00:00:00.000Z`,
    launchDate: null,
    exitLoad: null,
    minLumpsum: 5000,
    minAdditional: 1000,
    planType: scheme.schemeName.includes('Regular') ? 'regular' : 'direct',
    amcName: deriveAmcName(scheme.schemeName),
    familyName: null,
    morningstarRating: null,
    riskLabel: null,
    periodReturns: null,
    riskRatios: null,
  };
}
