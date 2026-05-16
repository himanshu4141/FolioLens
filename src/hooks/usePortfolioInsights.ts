/**
 * usePortfolioInsights — computes weighted portfolio composition from
 * fund_portfolio_composition rows and existing FundCardData.
 *
 * No extra DB round-trips for fund allocation — derived from fundCards
 * which are already cached by usePortfolio's React Query.
 *
 * Self-healing: if any fund's composition data is >35 days old the hook
 * exposes `isStale=true` and auto-invokes sync-fund-portfolios on mount.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authClient } from '@/src/lib/auth';
import { functionsClient } from '@/src/lib/functions';
import { analytics } from '@/src/lib/analytics';
import { fundPortfolioCompositionRepo } from '@/src/lib/data/fundPortfolioComposition';
import { parseFundName } from '@/src/utils/fundName';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { PERSIST_MAX_AGE_MS } from '@/src/lib/queryClient';
import { useAppStore } from '@/src/store/appStore';
import { PREVIEW_FUND_COMPOSITIONS } from '@/src/lib/previewData';
import type { FundCardData } from '@/src/hooks/usePortfolio';
import type {
  PortfolioInsights,
  FundPortfolioComposition,
  AssetMix,
  MarketCapMix,
  InsightHolding,
  InsightFundAllocation,
  InsightDebtFund,
  CompositionSource,
} from '@/src/types/app';

// Colour palette for fund allocation donut (up to 12 funds)
const FUND_PALETTE = [
  '#3b82f6', // blue
  '#f97316', // orange
  '#22c55e', // green
  '#a855f7', // purple
  '#ef4444', // red
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ec4899', // pink
  '#6366f1', // indigo
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#f43f5e', // rose
];

const STALE_DAYS = 35;

// ---------------------------------------------------------------------------
// DB fetch
// ---------------------------------------------------------------------------

export async function fetchCompositions(schemeCodes: number[]): Promise<FundPortfolioComposition[]> {
  if (!schemeCodes.length) return [];

  // Fetch the single best row per scheme_code:
  // prefer 'amfi' over 'category_rules', then most recent date.
  // 'amfi' < 'category_rules' alphabetically, so ASC puts amfi first.
  const { data, error } = await fundPortfolioCompositionRepo
    .from()
    .select('scheme_code, portfolio_date, equity_pct, debt_pct, cash_pct, other_pct, large_cap_pct, mid_cap_pct, small_cap_pct, not_classified_pct, sector_allocation, top_holdings, source')
    .in('scheme_code', schemeCodes)
    .order('scheme_code', { ascending: true })
    .order('source', { ascending: true }) // 'amfi' < 'category_rules' — ASC puts amfi first
    .order('portfolio_date', { ascending: false });

  if (error) throw error;

  // Deduplicate: keep the first (best) row per scheme_code
  const seen = new Set<number>();
  const rows: FundPortfolioComposition[] = [];
  for (const row of data ?? []) {
    if (seen.has(row.scheme_code)) continue;
    seen.add(row.scheme_code);
    rows.push({
      schemeCode: row.scheme_code,
      portfolioDate: row.portfolio_date,
      equityPct: row.equity_pct ?? 0,
      debtPct: row.debt_pct ?? 0,
      cashPct: row.cash_pct ?? 0,
      otherPct: row.other_pct ?? 0,
      largeCapPct: row.large_cap_pct ?? null,
      midCapPct: row.mid_cap_pct ?? null,
      smallCapPct: row.small_cap_pct ?? null,
      notClassifiedPct: row.not_classified_pct ?? null,
      sectorAllocation: row.sector_allocation as Record<string, number> | null,
      topHoldings: row.top_holdings as FundPortfolioComposition['topHoldings'],
      source: row.source as CompositionSource,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Weighted aggregation
// ---------------------------------------------------------------------------

export function computeInsights(
  fundCards: FundCardData[],
  compositions: FundPortfolioComposition[],
): PortfolioInsights {
  const totalValue = fundCards.reduce((s, f) => s + (f.currentValue ?? 0), 0);
  const compByScheme = new Map(compositions.map((c) => [c.schemeCode, c]));

  const missingDataFunds: string[] = [];
  const debtFunds: InsightDebtFund[] = [];
  let worstDate = new Date();
  let estimatedWeightPct = 0; // % of portfolio value covered by category_rules

  // Fund allocation (no composition data needed)
  const fundAllocation: InsightFundAllocation[] = fundCards
    .filter((f) => (f.currentValue ?? 0) > 0)
    .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))
    .map((f, idx) => ({
      fundId: f.id,
      shortName: parseFundName(f.schemeName).base,
      pct: totalValue > 0 ? ((f.currentValue ?? 0) / totalValue) * 100 : 0,
      value: f.currentValue ?? 0,
      color: FUND_PALETTE[idx % FUND_PALETTE.length],
    }));

  // Weighted composition
  const assetMix: AssetMix = { equity: 0, debt: 0, cash: 0, other: 0 };
  const marketCapMix: MarketCapMix = { large: 0, mid: 0, small: 0, notClassified: 0 };
  const sectorAccum: Record<string, number> = {};
  const holdingAccum: Map<string, { name: string; sector: string; marketCap: string; weight: number }> = new Map();

  for (const fund of fundCards) {
    const value = fund.currentValue ?? 0;
    if (value <= 0 || totalValue <= 0) continue;
    const weight = value / totalValue;

    const comp = compByScheme.get(fund.schemeCode);
    if (!comp) {
      missingDataFunds.push(fund.schemeName);
      continue;
    }

    // Both 'category_rules' and 'category_fallback' present SEBI category
    // averages rather than fund-specific data — count both against the
    // disclosure-banner threshold.
    if (comp.source === 'category_rules' || comp.source === 'category_fallback') {
      estimatedWeightPct += weight * 100;
    }

    // Funds with meaningful debt or cash exposure
    if (comp.debtPct >= 1 || comp.cashPct >= 5) {
      debtFunds.push({
        fundId: fund.id,
        shortName: parseFundName(fund.schemeName).base,
        debtPct: comp.debtPct,
        cashPct: comp.cashPct,
        portfolioPct: weight * 100,
      });
    }

    // Track oldest data date
    const compDate = new Date(comp.portfolioDate);
    if (compDate < worstDate) worstDate = compDate;

    // Asset mix (weighted sum)
    assetMix.equity += weight * comp.equityPct;
    assetMix.debt += weight * comp.debtPct;
    assetMix.cash += weight * comp.cashPct;
    assetMix.other += weight * comp.otherPct;

    // Market cap (weighted sum — these are already % of equity in each fund)
    if (comp.largeCapPct !== null) {
      // Convert to % of total portfolio: equityPct * marketCapPct / 100
      const equityWeight = weight * (comp.equityPct / 100);
      marketCapMix.large += equityWeight * (comp.largeCapPct ?? 0);
      marketCapMix.mid += equityWeight * (comp.midCapPct ?? 0);
      marketCapMix.small += equityWeight * (comp.smallCapPct ?? 0);
      marketCapMix.notClassified += equityWeight * (comp.notClassifiedPct ?? 0);
    }

    // Sector breakdown
    if (comp.sectorAllocation) {
      for (const [sector, pct] of Object.entries(comp.sectorAllocation)) {
        sectorAccum[sector] = (sectorAccum[sector] ?? 0) + weight * pct;
      }
    }

    // Holdings aggregation — key by ISIN when available, fall back to name
    if (comp.topHoldings) {
      for (const h of comp.topHoldings) {
        const key = h.isin || h.name;
        const existing = holdingAccum.get(key);
        const holdingPortfolioWeight = weight * (h.pctOfNav / 100);
        if (existing) {
          existing.weight += holdingPortfolioWeight;
        } else {
          holdingAccum.set(key, {
            name: h.name,
            sector: h.sector,
            marketCap: h.marketCap,
            weight: holdingPortfolioWeight,
          });
        }
      }
    }
  }

  // Normalise market cap to sum to 100% of equity
  const totalEquityPct = assetMix.equity;
  if (totalEquityPct > 0) {
    const mcTotal = marketCapMix.large + marketCapMix.mid + marketCapMix.small + marketCapMix.notClassified;
    if (mcTotal > 0) {
      const scale = 100 / mcTotal;
      marketCapMix.large = Math.round(marketCapMix.large * scale * 10) / 10;
      marketCapMix.mid = Math.round(marketCapMix.mid * scale * 10) / 10;
      marketCapMix.small = Math.round(marketCapMix.small * scale * 10) / 10;
      marketCapMix.notClassified = Math.round(
        (100 - marketCapMix.large - marketCapMix.mid - marketCapMix.small) * 10) / 10;
    }
  }

  // Sector breakdown — sort desc, keep all sectors
  const hasSectorData = Object.keys(sectorAccum).length > 0;
  const sectorBreakdown = hasSectorData
    ? Object.entries(sectorAccum)
        .sort(([, a], [, b]) => b - a)
        .map(([sector, weight]) => ({
          sector,
          weight: Math.round(weight * 10) / 10,
          value: Math.round((weight / 100) * totalValue),
        }))
    : null;

  // Top 30 holdings — sort desc by portfolio weight
  const hasHoldingData = holdingAccum.size > 0;
  const topHoldings: InsightHolding[] | null = hasHoldingData
    ? [...holdingAccum.entries()]
        .map(([isin, h]) => ({
          name: h.name,
          isin,
          sector: h.sector,
          marketCap: h.marketCap,
          portfolioWeight: Math.round(h.weight * 1000) / 10, // as %
          value: Math.round(h.weight * totalValue),
        }))
        .sort((a, b) => b.portfolioWeight - a.portfolioWeight)
        .slice(0, 30)
    : null;

  // Round asset mix
  assetMix.equity = Math.round(assetMix.equity * 10) / 10;
  assetMix.debt = Math.round(assetMix.debt * 10) / 10;
  assetMix.cash = Math.round(assetMix.cash * 10) / 10;
  assetMix.other = Math.round(assetMix.other * 10) / 10;

  // Show estimated banner only if >10% of portfolio value lacks real data
  const dataSource: CompositionSource = estimatedWeightPct > 10 ? 'category_rules' : 'amfi';

  // Sort debt funds by portfolio weight descending
  debtFunds.sort((a, b) => b.portfolioPct - a.portfolioPct);

  return {
    totalValue,
    dataAsOf: worstDate.toISOString().split('T')[0],
    dataSource,
    assetMix,
    marketCapMix,
    sectorBreakdown,
    topHoldings,
    fundAllocation,
    debtFunds,
    missingDataFunds,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePortfolioInsights(fundCards: FundCardData[]) {
  const queryClient = useQueryClient();
  const previewMode = useAppStore((s) => s.previewMode);
  const schemeCodes = [...new Set(fundCards.map((f) => f.schemeCode))];

  const {
    data: compositions,
    isLoading,
  } = useQuery({
    queryKey: previewMode
      ? ['portfolio-composition', 'preview', schemeCodes]
      : ['portfolio-composition', schemeCodes],
    // Preview mode short-circuits to the in-memory composition fixtures
    // (`PREVIEW_FUND_COMPOSITIONS`) so the Asset Mix card on Portfolio +
    // Portfolio Insights screen render real-looking allocations instead
    // of hanging on the "Syncing composition data from AMFI disclosures"
    // banner forever.
    queryFn: () =>
      previewMode
        ? Promise.resolve(
            PREVIEW_FUND_COMPOSITIONS.filter((c) => schemeCodes.includes(c.schemeCode)),
          )
        : fetchCompositions(schemeCodes),
    enabled: schemeCodes.length > 0,
    staleTime: STALE_TIMES.PORTFOLIO_COMPOSITION,
    gcTime: PERSIST_MAX_AGE_MS,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      await authClient.getSession();
      const res = await functionsClient.invoke('sync-fund-portfolios', {
        body: {},
      });
      if (res.error) throw res.error;
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio-composition'] });
    },
    onError: (error) => {
      // Cache audit finding #21. Without this handler, a failed sync
      // is silent: `isSyncing` flips back to false, but the user sees
      // no feedback and the composition data stays stale. We don't
      // invalidate the composition query (that would discard the
      // last-known-good data we'd otherwise still serve); we just log
      // + emit so a PostHog alert can fire if these spike.
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[usePortfolioInsights] sync-fund-portfolios mutation failed:', message);
      analytics.captureException(error, {
        source: 'usePortfolioInsights.syncMutation',
        message,
      });
    },
  });

  const insights = compositions && fundCards.length > 0
    ? computeInsights(fundCards, compositions)
    : null;

  // Staleness check: if the oldest composition date is >STALE_DAYS ago
  const isStale = compositions !== undefined && compositions.length > 0
    ? (() => {
        const oldest = compositions.reduce((min: Date, c: FundPortfolioComposition) => {
          const d = new Date(c.portfolioDate);
          return d < min ? d : min;
        }, new Date());
        const diffDays = (Date.now() - oldest.getTime()) / (1000 * 60 * 60 * 24);
        return diffDays > STALE_DAYS;
      })()
    : compositions?.length === 0; // no data at all → also stale

  // Auto-trigger sync on mount if stale or missing data
  const hasNoData = compositions !== undefined && compositions.length === 0;

  return {
    insights,
    isLoading,
    isStale,
    isSyncing: syncMutation.isPending,
    triggerSync: syncMutation.mutate,
    hasNoData,
  };
}
