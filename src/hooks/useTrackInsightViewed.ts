import { useEffect, useRef } from 'react';
import { analytics } from '@/src/lib/analytics';

export type InsightSurface =
  | 'home'
  | 'insights'
  | 'fund_detail'
  | 'funds'
  | 'wealth_journey'
  | 'tools'
  | 'goal_summary'
  | 'money_trail'
  | 'past_sip_check'
  | 'compare_funds'
  | 'direct_vs_regular';

/**
 * Emits a single `insight_viewed` event the first time the screen mounts.
 * Re-renders do not re-emit. Pass an optional `fundId` for per-fund surfaces.
 */
export function useTrackInsightViewed(surface: InsightSurface, fundId?: string | null) {
  const emittedRef = useRef(false);
  useEffect(() => {
    if (emittedRef.current) return;
    emittedRef.current = true;
    analytics.track('insight_viewed', {
      surface,
      fund_id: fundId ?? null,
    });
  }, [surface, fundId]);
}
