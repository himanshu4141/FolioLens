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

export const PREVIEW_USER_ID = 'preview-user';

/**
 * Synthesises a 30-day NAV history that ends at `currentNav` and starts
 * roughly `~3.5% lower`, so the sparkline trends up like a recovering
 * equity fund. Deterministic — same fund yields same series every render.
 */
function makeNavHistory30d(currentNav: number, schemeCode: number): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  const today = new Date('2026-05-09'); // pinned so the demo is identical regardless of clock skew
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
