import type { AnalyticsClient } from './analytics';

export const APP_RETURNED_THRESHOLD_MS = 5 * 60 * 1000;
export const FOREGROUND_SYNC_MIN_INTERVAL_MS = 30 * 1000;

export type AppLifecycleState = 'active' | 'background' | 'inactive';
export type AppLifecycleAuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | string;

export interface AppLifecycleSession {
  user: {
    id: string;
    email?: string | null;
  };
}

interface AppStartedMetadata {
  appVersion: string | null;
  easUpdateId: string | null;
  easUpdateCreatedAt: string | null;
  isEmbeddedLaunch: boolean;
  platform: string;
}

export interface AppLifecycleDependencies<TSyncResult> {
  analytics: AnalyticsClient;
  appStartedMetadata: AppStartedMetadata;
  isSqliteSupported: boolean;
  now: () => number;
  installGlobalErrorHandlers: () => void;
  getSession: () => Promise<AppLifecycleSession | null>;
  subscribeToAuth: (
    handler: (event: AppLifecycleAuthEvent, session: AppLifecycleSession | null) => void,
  ) => () => void;
  subscribeToAppState: (handler: (state: AppLifecycleState) => void) => () => void;
  bootstrapForUser: (userId: string) => Promise<TSyncResult>;
  syncDeltaForUser: (userId: string) => Promise<TSyncResult>;
  didSyncChangeData: (result: TSyncResult) => boolean;
  clearLocalDb: () => Promise<void>;
  clearQueryClient: () => void;
  invalidateQueries: (result: TSyncResult) => Promise<unknown> | unknown;
  removePersistedClient: () => Promise<unknown> | unknown;
  resetUserScopedState: () => void;
  clearOnboardingDraft: () => Promise<void>;
  getLocalTransactionCount: () => Promise<number | null>;
  warn: (message: string, error: unknown) => void;
}

/**
 * Install the application-wide auth, data, and foreground lifecycle.
 *
 * Correctness work is deliberately independent of PostHog. Only the three
 * optional analytics operations below are replaced with no-ops when the
 * build has no analytics key.
 */
export function startAppLifecycle<TSyncResult>(
  dependencies: AppLifecycleDependencies<TSyncResult>,
): () => void {
  const {
    analytics,
    appStartedMetadata,
    isSqliteSupported,
    now,
  } = dependencies;

  const track: AnalyticsClient['track'] = analytics.isEnabled
    ? (event, properties) => analytics.track(event, properties)
    : () => {};
  const identify: AnalyticsClient['identify'] = analytics.isEnabled
    ? (distinctId, properties) => analytics.identify(distinctId, properties)
    : () => {};
  const reset: AnalyticsClient['reset'] = analytics.isEnabled
    ? () => analytics.reset()
    : () => {};

  // Error forwarding is installed regardless of analytics configuration.
  // Its capture call uses the no-op analytics facade when PostHog is absent.
  dependencies.installGlobalErrorHandlers();

  track('app_started', {
    app_version: appStartedMetadata.appVersion,
    eas_update_id: appStartedMetadata.easUpdateId,
    eas_update_created_at: appStartedMetadata.easUpdateCreatedAt,
    is_embedded_launch: appStartedMetadata.isEmbeddedLaunch,
    platform: appStartedMetadata.platform,
  });

  let lastActiveAt = now();
  let lastForegroundSyncAt = 0;
  let pendingSignOutCleanup: Promise<void> | null = null;

  const identifySession = (session: AppLifecycleSession | null) => {
    if (session?.user) {
      identify(session.user.id, {
        email_domain: session.user.email?.split('@')[1] ?? null,
      });
      return;
    }
    reset();
  };

  const runBootstrap = (userId: string) => {
    void (async () => {
      try {
        if (pendingSignOutCleanup) {
          track('db_sync_awaiting_signout_cleanup');
          await pendingSignOutCleanup;
        }

        const preCount = analytics.isEnabled && isSqliteSupported
          ? await dependencies.getLocalTransactionCount()
          : null;
        track('db_sync_bootstrap_started', {
          local_tx_count_before: preCount,
        });

        const result = await dependencies.bootstrapForUser(userId);
        if (dependencies.didSyncChangeData(result)) {
          void dependencies.invalidateQueries(result);
        }
      } catch (error) {
        dependencies.warn('[db/sync] bootstrap failed', error);
      }
    })();
  };

  void dependencies.getSession().then((session) => {
    identifySession(session);
    if (isSqliteSupported && session?.user.id) {
      runBootstrap(session.user.id);
    }
  });

  const unsubscribeAuth = dependencies.subscribeToAuth((event, session) => {
    identifySession(session);

    if (isSqliteSupported && event === 'SIGNED_IN' && session?.user.id) {
      if (pendingSignOutCleanup) {
        track('auth_signin_after_recent_signout');
      }
      runBootstrap(session.user.id);
    }

    if (event !== 'SIGNED_OUT') return;

    dependencies.clearQueryClient();
    void dependencies.removePersistedClient();
    dependencies.resetUserScopedState();
    void dependencies.clearOnboardingDraft().catch((error) => {
      dependencies.warn('[onboarding] clearOnboardingDraft failed', error);
    });

    if (isSqliteSupported) {
      track('db_clear_local_db_started');
      pendingSignOutCleanup = dependencies.clearLocalDb()
        .then(() => {
          track('db_clear_local_db_completed');
        })
        .catch((error) => {
          dependencies.warn('[db/sync] clearAll failed', error);
          track('db_clear_local_db_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  });

  const unsubscribeAppState = dependencies.subscribeToAppState((nextState) => {
    if (nextState === 'active') {
      const currentTime = now();
      const idleMs = currentTime - lastActiveAt;
      lastActiveAt = currentTime;

      if (idleMs >= APP_RETURNED_THRESHOLD_MS) {
        track('app_returned', {
          previous_session_age_hours: Number((idleMs / 1000 / 60 / 60).toFixed(2)),
        });
      }

      if (isSqliteSupported) {
        const sinceLastSync = currentTime - lastForegroundSyncAt;
        if (sinceLastSync >= FOREGROUND_SYNC_MIN_INTERVAL_MS) {
          lastForegroundSyncAt = currentTime;
          void dependencies.getSession().then((session) => {
            const userId = session?.user.id;
            if (!userId) return;
            dependencies.syncDeltaForUser(userId)
              .then((result) => {
                if (dependencies.didSyncChangeData(result)) {
                  void dependencies.invalidateQueries(result);
                }
              })
              .catch((error) => {
                dependencies.warn('[db/sync] foreground delta failed', error);
              });
          });
        }
      }
      return;
    }

    if (nextState === 'background' || nextState === 'inactive') {
      lastActiveAt = now();
    }
  });

  return () => {
    unsubscribeAuth();
    unsubscribeAppState();
  };
}
