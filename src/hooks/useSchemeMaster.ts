/**
 * useSchemeMaster — per-scheme metadata cache.
 *
 * Multiple screens read `scheme_master` rows: Fund Detail wants the
 * "extended" columns (launch_date, exit_load, ratings, etc.), Compare
 * wants every column it has. Each was previously issuing its own
 * SELECT against the same table — a navigation from Compare to Fund
 * Detail for one of the compared schemes paid two round-trips even
 * though the data was identical.
 *
 * One producer, one cache key (`['scheme-master', schemeCode]`), one
 * SELECT shape. Subsequent reads of the same scheme hit the cache.
 * The data is slow-moving (scheme metadata refreshes on the daily
 * sync-fund-meta cron), so a long staleTime is safe.
 */
import { useQuery } from '@tanstack/react-query';
import { schemeMasterRepo } from '@/src/lib/data/schemeMaster';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { perfEnd, perfStart } from '@/src/lib/perfMark';

export interface SchemeMasterDbRow {
  scheme_code: number;
  scheme_name: string | null;
  scheme_category: string | null;
  benchmark_index: string | null;
  expense_ratio: number | null;
  aum_cr: number | null;
  isin: string | null;
  amc_name: string | null;
  family_name: string | null;
  plan_type: string | null;
  option_type: string | null;
  launch_date: string | null;
  exit_load: string | null;
  min_sip_amount: number | null;
  min_lumpsum: number | null;
  min_additional: number | null;
  morningstar_rating: number | null;
  risk_label: string | null;
  period_returns: unknown;
  risk_ratios: unknown;
}

const SCHEME_MASTER_COLUMNS =
  'scheme_code, scheme_name, scheme_category, benchmark_index, expense_ratio, aum_cr, isin, amc_name, family_name, plan_type, option_type, launch_date, exit_load, min_sip_amount, min_lumpsum, min_additional, morningstar_rating, risk_label, period_returns, risk_ratios';

export async function fetchSchemeMaster(
  schemeCode: number,
): Promise<SchemeMasterDbRow | null> {
  perfStart('query:schemeMaster');
  const { data, error } = await schemeMasterRepo
    .from()
    .select(SCHEME_MASTER_COLUMNS)
    .eq('scheme_code', schemeCode)
    .maybeSingle();
  perfEnd('query:schemeMaster', { found: !!data, scheme_code: schemeCode });
  if (error) throw error;
  return data as SchemeMasterDbRow | null;
}

export function useSchemeMaster(schemeCode: number | null | undefined) {
  return useQuery({
    queryKey: ['scheme-master', schemeCode],
    enabled: schemeCode != null,
    queryFn: () => fetchSchemeMaster(schemeCode!),
    // Scheme metadata changes via the daily sync-fund-meta cron, so
    // the 6-hour NAV stale time is the right granularity here too.
    staleTime: STALE_TIMES.NAV_HISTORY,
  });
}
