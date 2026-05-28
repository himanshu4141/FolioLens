/**
 * Lightweight hook for the most recent NAV date across the user's
 * holdings. Reads `MAX(nav_date)` straight from SQLite so the sidebar /
 * any other "stamp" surface can render without dragging in
 * `usePortfolio`'s 28k-row computation.
 *
 * Web has no SQLite — returns null there, callers should fall back to
 * `usePortfolio().summary.latestNavDate` if they need the stamp on web.
 *
 * Invalidated by `queryClient.invalidateQueries()` in the foreground /
 * pull-to-refresh handlers, same as every other read.
 */
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/src/hooks/useSession';
import { useAppStore } from '@/src/store/appStore';
import { SQLITE_AVAILABLE } from '@/src/lib/db/availability';
import { getDb } from '@/src/lib/db/db';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { PREVIEW_PORTFOLIO_SUMMARY } from '@/src/lib/previewData';

async function readLatestNavDate(): Promise<string | null> {
  if (!SQLITE_AVAILABLE) return null;
  const db = await getDb();
  const row = (await db.getFirstAsync<{ max_date: string | null }>(
    'SELECT MAX(nav_date) as max_date FROM nav',
  )) as { max_date: string | null } | null;
  return row?.max_date ?? null;
}

export function useLatestNavDate(): string | null {
  const { session } = useSession();
  const previewMode = useAppStore((s) => s.previewMode);
  const userId = session?.user.id;

  const { data } = useQuery({
    queryKey: previewMode ? ['latest-nav-date', 'preview'] : ['latest-nav-date', userId],
    enabled: previewMode || !!userId,
    queryFn: () =>
      previewMode
        ? Promise.resolve(PREVIEW_PORTFOLIO_SUMMARY.latestNavDate)
        : readLatestNavDate(),
    staleTime: STALE_TIMES.PORTFOLIO,
  });

  return data ?? null;
}
