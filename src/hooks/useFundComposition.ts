import { useQuery } from '@tanstack/react-query';
import { fetchCompositions } from '@/src/hooks/usePortfolioInsights';
import type { FundPortfolioComposition } from '@/src/types/app';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { PERSIST_MAX_AGE_MS } from '@/src/lib/queryClient';

export function useFundComposition(schemeCode: number | null) {
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio-composition', schemeCode !== null ? [schemeCode] : []],
    queryFn: () => fetchCompositions([schemeCode!]),
    enabled: schemeCode !== null,
    staleTime: STALE_TIMES.PORTFOLIO_COMPOSITION,
    gcTime: PERSIST_MAX_AGE_MS,
  });

  const composition: FundPortfolioComposition | null = data?.[0] ?? null;
  return { composition, isLoading };
}
