/**
 * Data-layer wrapper for the `user_fund` table and the `fund` compatibility
 * view (which joins user_fund + scheme_master).
 *
 * See `src/lib/data/README.md` for the convention.
 */
import { supabase } from '@/src/lib/supabase';

const USER_FUND_TABLE = 'user_fund' as const;
const FUND_VIEW = 'fund' as const;

export const userFundRepo = {
  /** Typed query builder against the physical user_fund table. */
  from: () => supabase.from(USER_FUND_TABLE),
};

/**
 * `fund` is a `security_invoker = true` view that joins user_fund
 * with scheme_master. Read-only — writes go through `userFundRepo`.
 */
export const fundViewRepo = {
  from: () => supabase.from(FUND_VIEW),
};
