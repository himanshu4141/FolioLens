-- AMFI stock market-cap classification reference table.
--
-- SEBI's stock categorization (Top 100 by 6m avg market cap = Large Cap,
-- 101-250 = Mid Cap, 251+ = Small Cap) is published twice a year by AMFI as
-- an Excel sheet at:
--   https://www.amfiindia.com/research-information/other-data/categorization-of-stocks
--
-- The sync-stock-market-cap edge function scrapes the listing page for the
-- latest .xlsx, parses it, and upserts ~750 rows into this table. The classifier
-- helpers in supabase/functions/_shared/portfolio-utils.ts join this table to
-- per-fund equity_holdings (by ISIN) to derive real large/mid/small cap
-- percentages instead of the SEBI-category defaults that previously stamped
-- every Flexi Cap fund with 38/33/29.

CREATE TABLE stock_market_cap (
  isin                   TEXT PRIMARY KEY,
  company_name           TEXT NOT NULL,
  market_cap_category    TEXT NOT NULL CHECK (market_cap_category IN ('Large Cap', 'Mid Cap', 'Small Cap')),
  rank                   INTEGER,                 -- 1-100 large, 101-250 mid, 251+ small
  avg_market_cap_cr      NUMERIC(14, 2),          -- 6-month average market cap in INR crore
  classification_period  TEXT NOT NULL,           -- e.g. 'H2-2025' (Jul-Dec 2025 list)
  source                 TEXT NOT NULL DEFAULT 'amfi',
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_market_cap_category ON stock_market_cap (market_cap_category);

COMMENT ON TABLE stock_market_cap IS
  'AMFI half-yearly stock categorization. Joined by ISIN to fund equity holdings '
  'to derive per-fund market-cap mix in sync-fund-portfolios and fetch-fund-snapshot. '
  'See docs/plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md.';

COMMENT ON COLUMN stock_market_cap.classification_period IS
  'AMFI publishes twice a year. Format ''H1-YYYY'' (Jan-Jun) or ''H2-YYYY'' (Jul-Dec). '
  'Used to detect no-op runs of the seeder when re-fetching the same period.';

-- Global reference data: all authenticated users may read, only service role may write.
ALTER TABLE stock_market_cap ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users can read stock_market_cap"
  ON stock_market_cap
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "service role has full access to stock_market_cap"
  ON stock_market_cap
  FOR ALL
  TO service_role
  USING (true);

-- Explicit Data API grants — auto-exposure of new public-schema tables was
-- revoked in 20260513000002_explicit_data_api_grants.sql, so every new
-- table needs its own GRANTs to be visible to the supabase-js client.
-- Shared catalog table pattern (matches scheme_master / fund_portfolio_composition):
--   authenticated → SELECT only (RLS gives row-level gating; writes flow through
--                   the service-role edge functions, not the client)
--   service_role  → ALL (belt-and-suspenders against any future REVOKE)
GRANT SELECT ON public.stock_market_cap TO authenticated;
GRANT ALL    ON public.stock_market_cap TO service_role;
