import { useQuery } from '@tanstack/react-query';
import { fetchCompositions } from '@/src/hooks/usePortfolioInsights';
import type { FundPortfolioComposition } from '@/src/types/app';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { PERSIST_MAX_AGE_MS } from '@/src/lib/queryClient';
import { useAppStore } from '@/src/store/appStore';
import { findPreviewCompositionByCode } from '@/src/lib/previewData';

export function useFundComposition(schemeCode: number | null) {
  const previewMode = useAppStore((s) => s.previewMode);
  const { data, isLoading } = useQuery({
    queryKey: previewMode
      ? ['portfolio-composition', 'preview', schemeCode]
      : ['portfolio-composition', schemeCode !== null ? [schemeCode] : []],
    queryFn: () => {
      if (previewMode && schemeCode != null) {
        const row = findPreviewCompositionByCode(schemeCode);
        return Promise.resolve(row ? [row] : []);
      }
      return fetchCompositions([schemeCode!]);
    },
    enabled: schemeCode !== null,
    staleTime: STALE_TIMES.PORTFOLIO_COMPOSITION,
    gcTime: PERSIST_MAX_AGE_MS,
  });

  const composition: FundPortfolioComposition | null = data?.[0] ?? null;
  return { composition, isLoading };
}
