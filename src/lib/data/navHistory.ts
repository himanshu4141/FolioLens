/**
 * Data-layer wrapper for the `nav_history` table.
 * See `src/lib/data/README.md` for the convention.
 */
import type { NavPoint } from '@/src/utils/navUtils';
import { supabase } from '@/src/lib/supabase';

const TABLE = 'nav_history' as const;

export const navHistoryRepo = {
  from: () => supabase.from(TABLE),

  /**
   * Fetch the last NAV per calendar month for a scheme.
   * Returns rows in ascending date order, suitable for `simulatePastSip`.
   * Reduces egress ~30× compared to the full nav_history series for
   * typical multi-year windows.
   */
  async monthEndNav(schemeCode: number): Promise<NavPoint[]> {
    const { data, error } = await supabase.rpc('month_end_nav', {
      p_scheme_code: schemeCode,
    });
    if (error) throw new Error(`month_end_nav failed: ${error.message}`);
    return (data ?? []).map((row: { nav_date: string; nav: number }) => ({
      date: row.nav_date,
      value: row.nav,
    }));
  },
};
