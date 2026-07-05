import type { Session } from '@/src/lib/auth';
import {
  OAuthCompletionCoordinator,
  type OAuthCompletionRuntime,
  type OAuthProvider,
  type OAuthTelemetryMetadata,
} from '@/src/lib/oauthCompletion';

const METADATA: OAuthTelemetryMetadata = {
  platform: 'android',
  app_version: '0.0.4',
  app_variant: 'preview-pr',
  eas_channel: 'foliolens-pr',
  eas_update_id: 'safe-update-id',
};

const SESSION = {
  access_token: 'session-access-secret',
  refresh_token: 'session-refresh-secret',
  expires_in: 3600,
  token_type: 'bearer',
  user: {
    id: 'provider-user-secret',
    email: 'person@example.com',
    identities: [
      { provider: 'email' },
      { provider: 'google' },
    ],
  },
} as Session;

function successfulAuthResult() {
  return { data: { session: SESSION }, error: null };
}

function createHarness(overrides: {
  exchange?: jest.Mock;
  setSession?: jest.Mock;
  waitForSession?: jest.Mock;
  reconcileSession?: jest.Mock;
  navigateToTabs?: jest.Mock;
} = {}) {
  const exchange = overrides.exchange ?? jest.fn().mockResolvedValue(successfulAuthResult());
  const setSession = overrides.setSession ?? jest.fn().mockResolvedValue(successfulAuthResult());
  const provider: OAuthProvider = {
    exchangeCodeForSession: exchange,
    setSession,
  };
  const track = jest.fn();
  const coordinator = new OAuthCompletionCoordinator({
    provider,
    track,
    now: () => 1000,
  });
  const runtime: OAuthCompletionRuntime = {
    metadata: METADATA,
    waitForSession: overrides.waitForSession ?? jest.fn().mockResolvedValue(SESSION),
    reconcileSession: overrides.reconcileSession ?? jest.fn().mockResolvedValue(SESSION),
    navigateToTabs: overrides.navigateToTabs ?? jest.fn(),
  };
  return { coordinator, exchange, setSession, track, runtime };
}

describe('OAuthCompletionCoordinator', () => {
  it('deduplicates WebBrowser and Router delivery and exchanges the code itself once', async () => {
    const harness = createHarness();
    harness.coordinator.beginAttempt('sign_in', METADATA);
    const callback = 'foliolens-pr://auth/callback?code=one-time-code';

    const [browser, router] = await Promise.all([
      harness.coordinator.completeCallback(callback, 'web_browser', harness.runtime),
      harness.coordinator.completeCallback(callback, 'router', harness.runtime),
    ]);

    expect(browser).toEqual(router);
    expect(browser).toMatchObject({ status: 'success', transport: 'code' });
    expect(harness.exchange).toHaveBeenCalledTimes(1);
    expect(harness.exchange).toHaveBeenCalledWith('one-time-code');
    expect(harness.runtime.navigateToTabs).toHaveBeenCalledTimes(1);
  });

  it('reuses a completed callback without replaying exchange or navigation', async () => {
    const harness = createHarness();
    const callback = 'foliolens-main://auth/callback?code=replayed-code';

    await harness.coordinator.completeCallback(callback, 'router', harness.runtime);
    await harness.coordinator.completeCallback(callback, 'web_browser', harness.runtime);

    expect(harness.exchange).toHaveBeenCalledTimes(1);
    expect(harness.runtime.navigateToTabs).toHaveBeenCalledTimes(1);
  });

  it('supports one legacy fragment callback through setSession', async () => {
    const harness = createHarness();
    const result = await harness.coordinator.completeCallback(
      'foliolens://auth/callback#access_token=legacy-access&refresh_token=legacy-refresh',
      'router',
      harness.runtime,
    );

    expect(result).toMatchObject({ status: 'success', transport: 'fragment' });
    expect(harness.setSession).toHaveBeenCalledWith({
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
    });
    expect(harness.exchange).not.toHaveBeenCalled();
  });

  it('reconciles once when the shared session event is missed', async () => {
    const waitForSession = jest.fn().mockRejectedValue(new Error('missed event'));
    const reconcileSession = jest.fn().mockResolvedValue(SESSION);
    const harness = createHarness({ waitForSession, reconcileSession });

    const result = await harness.coordinator.completeCallback(
      'foliolens-pr://auth/callback?code=persisted-before-navigation',
      'web_browser',
      harness.runtime,
    );

    expect(result.status).toBe('success');
    expect(reconcileSession).toHaveBeenCalledTimes(1);
    expect(harness.runtime.navigateToTabs).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable error on network failure without navigating', async () => {
    const exchange = jest.fn().mockRejectedValue(new Error('network offline'));
    const harness = createHarness({ exchange });

    const result = await harness.coordinator.completeCallback(
      'foliolens-pr://auth/callback?code=network-failure-code',
      'router',
      harness.runtime,
    );

    expect(result).toMatchObject({ status: 'error', reason: 'exchange_failed' });
    expect(harness.runtime.navigateToTabs).not.toHaveBeenCalled();
  });

  it('rejects a callback when neither the event nor reconciliation confirms its session', async () => {
    const harness = createHarness({
      waitForSession: jest.fn().mockRejectedValue(new Error('timeout')),
      reconcileSession: jest.fn().mockResolvedValue(null),
    });

    const result = await harness.coordinator.completeCallback(
      'foliolens-pr://auth/callback?code=unconfirmed-code',
      'router',
      harness.runtime,
    );

    expect(result).toMatchObject({
      status: 'error',
      reason: 'session_confirmation_failed',
    });
    expect(harness.runtime.navigateToTabs).not.toHaveBeenCalled();
  });

  it('emits the required stages without callback credentials or user identity', async () => {
    const harness = createHarness();
    harness.coordinator.beginAttempt('sign_in', METADATA);
    harness.coordinator.recordBrowserReturned('success');
    await harness.coordinator.completeCallback(
      'foliolens-pr://auth/callback?code=telemetry-secret-code',
      'web_browser',
      harness.runtime,
    );

    expect(harness.track.mock.calls.map(([event]) => event)).toEqual([
      'oauth_started',
      'browser_returned',
      'callback_received',
      'session_started',
      'session_confirmed',
      'navigation_completed',
    ]);
    const telemetry = JSON.stringify(harness.track.mock.calls);
    expect(telemetry).not.toContain('telemetry-secret-code');
    expect(telemetry).not.toContain('session-access-secret');
    expect(telemetry).not.toContain('session-refresh-secret');
    expect(telemetry).not.toContain('person@example.com');
    expect(telemetry).not.toContain('provider-user-secret');
  });
});
