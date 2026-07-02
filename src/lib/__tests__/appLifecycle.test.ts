import {
  startAppLifecycle,
  type AppLifecycleAuthEvent,
  type AppLifecycleDependencies,
  type AppLifecycleSession,
  type AppLifecycleState,
} from '@/src/lib/appLifecycle';

interface SyncResult {
  changed: boolean;
}

const USER_SESSION: AppLifecycleSession = {
  user: {
    id: 'user-1',
    email: 'person@example.com',
  },
};

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(initialSession: AppLifecycleSession | null = USER_SESSION) {
  let authHandler:
    | ((event: AppLifecycleAuthEvent, session: AppLifecycleSession | null) => void)
    | null = null;
  let appStateHandler: ((state: AppLifecycleState) => void) | null = null;
  let currentTime = 100_000;

  const analytics = {
    isEnabled: false,
    track: jest.fn(),
    identify: jest.fn(),
    reset: jest.fn(),
    captureException: jest.fn(),
  };
  const unsubscribeAuth = jest.fn();
  const unsubscribeAppState = jest.fn();

  const dependencies: AppLifecycleDependencies<SyncResult> = {
    analytics,
    appStartedMetadata: {
      appVersion: '0.0.4',
      easUpdateId: 'test-update',
      easUpdateCreatedAt: '2026-07-02T00:00:00.000Z',
      isEmbeddedLaunch: false,
      platform: 'android',
    },
    isSqliteSupported: true,
    now: jest.fn(() => currentTime),
    installGlobalErrorHandlers: jest.fn(),
    getSession: jest.fn(async () => initialSession),
    subscribeToAuth: jest.fn((handler) => {
      authHandler = handler;
      return unsubscribeAuth;
    }),
    subscribeToAppState: jest.fn((handler) => {
      appStateHandler = handler;
      return unsubscribeAppState;
    }),
    bootstrapForUser: jest.fn(async () => ({ changed: false })),
    syncDeltaForUser: jest.fn(async () => ({ changed: false })),
    didSyncChangeData: jest.fn((result) => result.changed),
    clearLocalDb: jest.fn(async () => {}),
    clearQueryClient: jest.fn(),
    invalidateQueries: jest.fn(async () => {}),
    removePersistedClient: jest.fn(async () => {}),
    resetUserScopedState: jest.fn(),
    clearOnboardingDraft: jest.fn(async () => {}),
    getLocalTransactionCount: jest.fn(async () => 566),
    warn: jest.fn(),
  };

  return {
    analytics,
    dependencies,
    emitAuth(event: AppLifecycleAuthEvent, session: AppLifecycleSession | null) {
      if (!authHandler) throw new Error('Auth listener is not installed');
      authHandler(event, session);
    },
    emitAppState(state: AppLifecycleState) {
      if (!appStateHandler) throw new Error('App-state listener is not installed');
      appStateHandler(state);
    },
    setCurrentTime(value: number) {
      currentTime = value;
    },
    unsubscribeAuth,
    unsubscribeAppState,
  };
}

describe('startAppLifecycle with analytics disabled', () => {
  it('installs error handlers and runs initial native bootstrap', async () => {
    const harness = createHarness();

    const stop = startAppLifecycle(harness.dependencies);
    await settlePromises();

    expect(harness.dependencies.installGlobalErrorHandlers).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.bootstrapForUser).toHaveBeenCalledWith('user-1');
    expect(harness.dependencies.getLocalTransactionCount).not.toHaveBeenCalled();
    expect(harness.analytics.track).not.toHaveBeenCalled();
    expect(harness.analytics.identify).not.toHaveBeenCalled();
    expect(harness.analytics.reset).not.toHaveBeenCalled();

    stop();
    expect(harness.unsubscribeAuth).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribeAppState).toHaveBeenCalledTimes(1);
  });

  it('bootstraps on SIGNED_IN without analytics', async () => {
    const harness = createHarness(null);
    startAppLifecycle(harness.dependencies);
    await settlePromises();

    harness.emitAuth('SIGNED_IN', USER_SESSION);
    await settlePromises();

    expect(harness.dependencies.bootstrapForUser).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.bootstrapForUser).toHaveBeenCalledWith('user-1');
    expect(harness.analytics.identify).not.toHaveBeenCalled();
  });

  it('clears every user-scoped cache on SIGNED_OUT without analytics', async () => {
    const harness = createHarness(null);
    startAppLifecycle(harness.dependencies);
    await settlePromises();

    harness.emitAuth('SIGNED_OUT', null);
    await settlePromises();

    expect(harness.dependencies.clearQueryClient).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.removePersistedClient).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.resetUserScopedState).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.clearOnboardingDraft).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.clearLocalDb).toHaveBeenCalledTimes(1);
    expect(harness.analytics.reset).not.toHaveBeenCalled();
  });

  it('runs and throttles foreground delta sync without analytics', async () => {
    const harness = createHarness();
    startAppLifecycle(harness.dependencies);
    await settlePromises();
    jest.mocked(harness.dependencies.syncDeltaForUser).mockClear();

    harness.setCurrentTime(200_000);
    harness.emitAppState('active');
    await settlePromises();

    expect(harness.dependencies.syncDeltaForUser).toHaveBeenCalledWith('user-1');

    harness.setCurrentTime(205_000);
    harness.emitAppState('active');
    await settlePromises();

    expect(harness.dependencies.syncDeltaForUser).toHaveBeenCalledTimes(1);
    expect(harness.analytics.track).not.toHaveBeenCalled();
  });

  it('waits for sign-out SQLite cleanup before a subsequent sign-in bootstrap', async () => {
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const harness = createHarness(null);
    jest.mocked(harness.dependencies.clearLocalDb).mockReturnValue(cleanup);
    startAppLifecycle(harness.dependencies);
    await settlePromises();

    harness.emitAuth('SIGNED_OUT', null);
    harness.emitAuth('SIGNED_IN', USER_SESSION);
    await settlePromises();

    expect(harness.dependencies.bootstrapForUser).not.toHaveBeenCalled();

    resolveCleanup();
    await settlePromises();

    expect(harness.dependencies.bootstrapForUser).toHaveBeenCalledWith('user-1');
  });

  it('preserves the web guard while still clearing non-SQLite caches', async () => {
    const harness = createHarness();
    harness.dependencies.isSqliteSupported = false;
    startAppLifecycle(harness.dependencies);
    await settlePromises();

    harness.emitAppState('active');
    harness.emitAuth('SIGNED_OUT', null);
    await settlePromises();

    expect(harness.dependencies.bootstrapForUser).not.toHaveBeenCalled();
    expect(harness.dependencies.syncDeltaForUser).not.toHaveBeenCalled();
    expect(harness.dependencies.clearLocalDb).not.toHaveBeenCalled();
    expect(harness.dependencies.clearQueryClient).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.removePersistedClient).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.resetUserScopedState).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.clearOnboardingDraft).toHaveBeenCalledTimes(1);
  });

  it('retains lifecycle diagnostics when analytics is enabled', async () => {
    const harness = createHarness();
    harness.analytics.isEnabled = true;
    startAppLifecycle(harness.dependencies);
    await settlePromises();

    expect(harness.analytics.track).toHaveBeenCalledWith('app_started', {
      app_version: '0.0.4',
      eas_update_id: 'test-update',
      eas_update_created_at: '2026-07-02T00:00:00.000Z',
      is_embedded_launch: false,
      platform: 'android',
    });
    expect(harness.analytics.identify).toHaveBeenCalledWith('user-1', {
      email_domain: 'example.com',
    });
    expect(harness.dependencies.getLocalTransactionCount).toHaveBeenCalledTimes(1);
    expect(harness.analytics.track).toHaveBeenCalledWith('db_sync_bootstrap_started', {
      local_tx_count_before: 566,
    });
  });
});
