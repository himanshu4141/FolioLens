// Domain types derived from the database schema + computed fields.
// These are used throughout the app — not the raw DB types.

export type TransactionType =
  | 'purchase'
  | 'redemption'
  | 'switch_in'
  | 'switch_out'
  | 'dividend_reinvest';

export type ImportSource = 'email' | 'qr' | 'pdf';
export type ImportStatus = 'pending' | 'success' | 'failed';

export interface Fund {
  id: string;
  schemeCode: number;
  schemeName: string;
  schemeCategory: string;
  benchmarkIndex: string | null;
  benchmarkIndexSymbol: string | null;
  isActive: boolean;
}

export interface Transaction {
  id: string;
  fundId: string;
  transactionDate: string;
  transactionType: TransactionType;
  units: number;
  navAtTransaction: number;
  amount: number;
  folioNumber: string | null;
}

export interface NavDataPoint {
  date: string;
  nav: number;
}

export interface IndexDataPoint {
  date: string;
  closeValue: number;
}

export type TimeWindow = '1M' | '3M' | '6M' | '1Y' | '3Y' | 'ALL';

// ---------------------------------------------------------------------------
// Portfolio Insights types
// ---------------------------------------------------------------------------

/**
 * Holdings provenance, highest precedence first (see
 * `src/utils/compositionSource.ts` for the rank used by the best-row selector):
 * - 'official' — parsed AMC monthly disclosures from OpenFolio-Data: real
 *   ISIN-bearing equity AND debt holdings, sectors, and cap split.
 * - 'amfi' — large/mid/small cap pcts derived from the per-fund AMFI
 *   classifier over mfdata.in holdings (enrichment / backup source).
 * - 'category_fallback' — fund disclosed holdings but classifier coverage
 *   was zero (e.g. all foreign equity, or AMFI list missed every ISIN).
 *   Cap pcts are SEBI category averages; UI surfaces a disclaimer.
 * - 'category_rules' — no holdings disclosed at all. Cap pcts are SEBI
 *   category averages; UI surfaces the same disclaimer.
 */
export type CompositionSource = 'official' | 'category_rules' | 'category_fallback' | 'amfi';

export interface HoldingItem {
  name: string;
  isin: string;
  sector: string;
  marketCap: 'Large Cap' | 'Mid Cap' | 'Small Cap' | 'Other';
  pctOfNav: number;
}

export interface FundPortfolioComposition {
  schemeCode: number;
  portfolioDate: string;
  equityPct: number;
  debtPct: number;
  cashPct: number;
  otherPct: number;
  largeCapPct: number | null;
  midCapPct: number | null;
  smallCapPct: number | null;
  notClassifiedPct: number | null;
  sectorAllocation: Record<string, number> | null;
  topHoldings: HoldingItem[] | null;
  source: CompositionSource;
}

export interface AssetMix {
  equity: number;
  debt: number;
  cash: number;
  other: number;
}

export interface MarketCapMix {
  large: number;
  mid: number;
  small: number;
  notClassified: number;
}

export interface InsightHolding {
  name: string;
  isin: string;
  sector: string;
  marketCap: string;
  portfolioWeight: number;
  value: number;
}

export interface InsightFundAllocation {
  fundId: string;
  shortName: string;
  pct: number;
  value: number;
  color: string;
}

export interface InsightDebtFund {
  fundId: string;
  shortName: string;
  debtPct: number;
  cashPct: number;
  portfolioPct: number;
}

export interface PortfolioInsights {
  totalValue: number;
  dataAsOf: string;
  dataSource: CompositionSource;
  assetMix: AssetMix;
  marketCapMix: MarketCapMix;
  sectorBreakdown: { sector: string; weight: number; value: number }[] | null;
  topHoldings: InsightHolding[] | null;
  fundAllocation: InsightFundAllocation[];
  debtFunds: InsightDebtFund[];
  missingDataFunds: string[];
}
