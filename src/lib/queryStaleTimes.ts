/**
 * Per-query staleTime constants.
 *
 * "Stale" in React Query's vocabulary is "we'll keep showing the cached
 * value, but the next mount also fires a background refetch to confirm".
 * Past NAVs and past index closes never change, so a long staleTime is
 * safe — today's tick still arrives via the daily background refetch
 * triggered the first time something mounts post-publish.
 *
 * Volatile data (transactions added in-session, profile edits) keeps a
 * short staleTime so a user who finishes onboarding and immediately
 * lands on the Portfolio screen doesn't see stale "zero funds" state.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const STALE_TIMES = {
  // Default for any query that doesn't pick a labelled value.
  DEFAULT: 5 * MIN,

  // NAV / index publish daily (~22:30 IST). Stale-while-revalidate over
  // a 6h window keeps the user from seeing a spinner during the daily
  // window when the publish hasn't happened yet.
  NAV_HISTORY: 6 * HOUR,
  INDEX_HISTORY: 6 * HOUR,

  // Portfolio aggregates depend on NAV — same cadence works.
  PORTFOLIO: 1 * HOUR,
  PORTFOLIO_COMPOSITION: 1 * HOUR,
  INVESTMENT_VS_BENCHMARK: 1 * HOUR,
  PERFORMANCE_TIMELINE: 1 * HOUR,
  PORTFOLIO_TIMELINE: 1 * HOUR,

  // Money trail / transactions — user can add new transactions in a
  // session (CAS upload), so revalidate aggressively.
  MONEY_TRAIL: 5 * MIN,
  USER_TRANSACTIONS: 5 * MIN,
  USER_FUNDS: 5 * MIN,

  // User profile — short, since the wizard writes to it.
  USER_PROFILE: 5 * MIN,
} as const;

export type StaleTimeKey = keyof typeof STALE_TIMES;
