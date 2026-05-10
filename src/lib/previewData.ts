/**
 * Read-only fixtures powering "Preview the app" mode.
 *
 * The numbers here are intentionally realistic — they should look like
 * a believable 3-year portfolio of an Indian retail investor — but they
 * are entirely synthetic and deterministic. The fund names/categories
 * are real schemes (so `schemeCategory` and the cap-tilt segments make
 * sense visually), but the units, NAVs, and transactions are made up
 * and not meant to match anything live.
 *
 * Consumed by:
 *  - usePortfolio (returns this directly when `previewMode` is on)
 *  - useFundDetail (matches by id, returns the single fund + nav history)
 *  - any hook that shouldn't query Supabase for the preview user
 */

import type { FundCardData, PortfolioSummary } from '@/src/hooks/usePortfolio';
import type { MoneyTrailData } from '@/src/hooks/useMoneyTrail';
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

/**
 * Synthesises a 30-day NAV history that ends at `currentNav` and starts
 * roughly `~3.5% lower`, so the sparkline trends up like a recovering
 * equity fund. Deterministic — same fund yields same series every render.
 */
function makeNavHistory30d(currentNav: number, schemeCode: number): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const today = PREVIEW_TODAY;
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    // Walk from -3.5% to current with a tiny pseudo-random oscillation seeded by scheme code.
    const t = (29 - i) / 29;
    const base = currentNav * (1 - 0.035 * (1 - t));
    const noise = Math.sin((schemeCode + i) * 1.7) * (currentNav * 0.004);
    out.push({ date: d.toISOString().split('T')[0], value: Math.round((base + noise) * 100) / 100 });
  }
  return out;
}

interface PreviewFundSeed {
  id: string;
  schemeName: string;
  schemeCategory: string;
  schemeCode: number;
  currentNav: number;
  previousNav: number; // for daily change
  currentUnits: number;
  investedAmount: number;
  realizedGain: number;
  realizedAmount: number;
  redeemedUnits: number;
  returnXirr: number;
}

const SEEDS: PreviewFundSeed[] = [
  {
    id: 'preview-fund-1',
    schemeName: 'Parag Parikh Flexi Cap Fund — Direct Growth',
    schemeCategory: 'Flexi Cap',
    schemeCode: 122639,
    currentNav: 84.21,
    previousNav: 83.55,
    currentUnits: 5800,
    investedAmount: 360000,
    realizedGain: 0,
    realizedAmount: 0,
    redeemedUnits: 0,
    returnXirr: 0.182,
  },
  {
    id: 'preview-fund-2',
    schemeName: 'Mirae Asset Large Cap Fund — Direct Growth',
    schemeCategory: 'Large Cap',
    schemeCode: 118834,
    currentNav: 112.43,
    previousNav: 111.88,
    currentUnits: 2740,
    investedAmount: 240000,
    realizedGain: 0,
    realizedAmount: 0,
    redeemedUnits: 0,
    returnXirr: 0.143,
  },
  {
    id: 'preview-fund-3',
    schemeName: 'HDFC Mid-Cap Opportunities Fund — Direct Growth',
    schemeCategory: 'Mid Cap',
    schemeCode: 118989,
    currentNav: 168.55,
    previousNav: 169.92,
    currentUnits: 1820,
    investedAmount: 240000,
    realizedGain: 18400,
    realizedAmount: 60000,
    redeemedUnits: 360,
    returnXirr: 0.214,
  },
  {
    id: 'preview-fund-4',
    schemeName: 'Axis Small Cap Fund — Direct Growth',
    schemeCategory: 'Small Cap',
    schemeCode: 122639,
    currentNav: 92.18,
    previousNav: 92.05,
    currentUnits: 2960,
    investedAmount: 200000,
    realizedGain: 0,
    realizedAmount: 0,
    redeemedUnits: 0,
    returnXirr: 0.227,
  },
  {
    id: 'preview-fund-5',
    schemeName: 'ICICI Prudential Liquid Fund — Direct Growth',
    schemeCategory: 'Liquid',
    schemeCode: 120186,
    currentNav: 358.27,
    previousNav: 358.18,
    currentUnits: 480,
    investedAmount: 160000,
    realizedGain: 0,
    realizedAmount: 0,
    redeemedUnits: 0,
    returnXirr: 0.069,
  },
];

function buildFundCard(seed: PreviewFundSeed): FundCardData {
  const currentValue = Math.round(seed.currentNav * seed.currentUnits * 100) / 100;
  const dailyChangeAmount = Math.round((seed.currentNav - seed.previousNav) * seed.currentUnits * 100) / 100;
  const dailyChangePct =
    seed.previousNav > 0 ? ((seed.currentNav - seed.previousNav) / seed.previousNav) * 100 : 0;
  return {
    id: seed.id,
    schemeName: seed.schemeName,
    schemeCategory: seed.schemeCategory,
    schemeCode: seed.schemeCode,
    currentNav: seed.currentNav,
    previousNav: seed.previousNav,
    currentUnits: seed.currentUnits,
    currentValue,
    investedAmount: seed.investedAmount,
    dailyChangeAmount,
    dailyChangePct,
    returnXirr: seed.returnXirr,
    realizedGain: seed.realizedGain,
    realizedAmount: seed.realizedAmount,
    redeemedUnits: seed.redeemedUnits,
    navHistory30d: makeNavHistory30d(seed.currentNav, seed.schemeCode),
  };
}

export const PREVIEW_FUND_CARDS: FundCardData[] = SEEDS.map(buildFundCard);

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
  // Aggregate XIRR weighted by current value — close enough for the preview.
  xirr:
    totalValue > 0
      ? PREVIEW_FUND_CARDS.reduce(
          (sum, f) => sum + f.returnXirr * ((f.currentValue ?? 0) / totalValue),
          0,
        )
      : 0,
  marketXirr: 0.118, // Nifty 50 TRI ~ 11.8% over the same horizon — close to real
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

// ── Money Trail fixtures ─────────────────────────────────────────────────────
//
// Generates ~24 months of monthly SIPs per fund plus a single redemption for
// the one fund whose seed has a non-zero realizedAmount. Sums match the seed
// `investedAmount` exactly so the home portfolio numbers and the Money Trail
// summary stay consistent.
//
// AMC name is derived from the first word of the scheme name — accurate enough
// for the AMC filter pill to render plausibly without us hand-curating it.

const SIP_MONTHS = 24;

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function deriveAmcName(schemeName: string): string {
  // "Parag Parikh Flexi Cap Fund — Direct Growth" → "Parag Parikh"
  // "Mirae Asset Large Cap Fund — Direct Growth" → "Mirae Asset"
  // "HDFC Mid-Cap Opportunities Fund — Direct Growth" → "HDFC"
  const cleaned = schemeName.split('—')[0].trim();
  const words = cleaned.split(/\s+/);
  if (words.length >= 2 && /^(asset|parikh)$/i.test(words[1])) {
    return `${words[0]} ${words[1]}`;
  }
  return words[0] ?? schemeName;
}

function buildPreviewRawTransactions(): RawMoneyTrailTransaction[] {
  const rows: RawMoneyTrailTransaction[] = [];
  const today = PREVIEW_TODAY;

  for (const seed of SEEDS) {
    const totalSipAmount = seed.investedAmount + seed.realizedAmount;
    const monthlySip = Math.round(totalSipAmount / SIP_MONTHS);
    // Approximate per-SIP NAV by linearly fading from current NAV down to
    // 80% of current — a believable upward path for a growing equity fund.
    for (let i = 0; i < SIP_MONTHS; i++) {
      const monthsAgo = SIP_MONTHS - 1 - i;
      const txDate = new Date(today);
      txDate.setMonth(today.getMonth() - monthsAgo);
      txDate.setDate(5); // every SIP lands on the 5th
      const navProgress = i / Math.max(1, SIP_MONTHS - 1);
      const navAtTx = Math.round(seed.currentNav * (0.8 + 0.2 * navProgress) * 100) / 100;
      const units = Math.round((monthlySip / navAtTx) * 1000) / 1000;
      rows.push({
        id: `preview-tx-${seed.id}-${i}`,
        fund_id: seed.id,
        fund_name: seed.schemeName,
        scheme_category: seed.schemeCategory,
        amc_name: deriveAmcName(seed.schemeName),
        transaction_date: isoDate(txDate),
        transaction_type: 'sip_purchase',
        units,
        amount: monthlySip,
        nav_at_transaction: navAtTx,
        folio_number: `${seed.schemeCode % 100000}/${seed.id.slice(-2).toUpperCase()}`,
        cas_import_id: 'preview-import',
        created_at: `${isoDate(txDate)}T10:00:00.000Z`,
      });
    }

    // Partial redemption for the one seed that has realized amount.
    if (seed.realizedAmount > 0 && seed.redeemedUnits > 0) {
      const redemptionDate = new Date(today);
      redemptionDate.setMonth(today.getMonth() - 4);
      redemptionDate.setDate(20);
      const navAtRedemption =
        Math.round(((seed.realizedAmount / seed.redeemedUnits) || seed.currentNav) * 100) / 100;
      rows.push({
        id: `preview-tx-${seed.id}-redeem`,
        fund_id: seed.id,
        fund_name: seed.schemeName,
        scheme_category: seed.schemeCategory,
        amc_name: deriveAmcName(seed.schemeName),
        transaction_date: isoDate(redemptionDate),
        transaction_type: 'redemption',
        units: -seed.redeemedUnits,
        amount: -seed.realizedAmount,
        nav_at_transaction: navAtRedemption,
        folio_number: `${seed.schemeCode % 100000}/${seed.id.slice(-2).toUpperCase()}`,
        cas_import_id: 'preview-import',
        created_at: `${isoDate(redemptionDate)}T10:00:00.000Z`,
      });
    }
  }

  return rows;
}

const PREVIEW_RAW_TRANSACTIONS = buildPreviewRawTransactions();

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
