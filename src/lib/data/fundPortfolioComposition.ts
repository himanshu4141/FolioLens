/**
 * Data-layer wrapper for the `fund_portfolio_composition` table.
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const TABLE = 'fund_portfolio_composition' as const;

export const fundPortfolioCompositionRepo = {
  from: () => supabase.from(TABLE),
};
