import type { Session } from '@/src/lib/auth';
import {
  parseOAuthCallback,
  type OAuthCallbackPayload,
} from '@/src/utils/authUtils';

export const OAUTH_EXCHANGE_TIMEOUT_MS = 20_000;
export const OAUTH_SESSION_CONFIRM_TIMEOUT_MS = 8_000;
export const OAUTH_RECONCILE_TIMEOUT_MS = 8_000;
export const OAUTH_NAVIGATION_TIMEOUT_MS = 5_000;

export type OAuthIntent = 'sign_in' | 'link_identity';
export type OAuthCallbackSource = 'web_browser' | 'router';
export type OAuthTransport = 'code' | 'fragment';

export interface OAuthTelemetryMetadata {
  platform: string;
  app_version: string | null;
  app_variant: string | null;
  eas_channel: string | null;
  eas_update_id: string | null;
}

interface AuthResult {
  data: { session: Session | null };
  error: { message: string } | null;
}

export interface OAuthProvider {
  exchangeCodeForSession(code: string): Promise<AuthResult>;
  setSession(tokens: {
    access_token: string;
    refresh_token: string;
  }): Promise<AuthResult>;
}

export interface OAuthCompletionRuntime {
  metadata: OAuthTelemetryMetadata;
  waitForSession: (
    expected: { userId: string; accessToken?: string },
    timeoutMs: number,
  ) => Promise<Session>;
  reconcileSession: () => Promise<Session | null>;
  navigateToTabs: () => void | Promise<void>;
}

export type OAuthCompletionResult =
  | {
    status: 'success';
    transport: OAuthTransport;
    wasAutoLinked: boolean;
  }
  | {
    status: 'error';
    reason:
      | 'provider_error'
      | 'invalid_callback'
      | 'exchange_failed'
      | 'exchange_timeout'
      | 'session_confirmation_failed'
      | 'navigation_failed';
    message: string;
    isDuplicate: boolean;
  };

interface Attempt {
  flowId: string;
  intent: OAuthIntent;
  startedAt: number;
  metadata: OAuthTelemetryMetadata;
}

interface CoordinatorDependencies {
  provider: OAuthProvider;
  track: (event: string, properties: Record<string, unknown>) => void;
  now?: () => number;
  timeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  exchangeTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  navigationTimeoutMs?: number;
  maxRememberedCallbacks?: number;
}

export class OAuthStageTimeoutError extends Error {
  constructor(readonly stage: string) {
    super(`OAuth stage timed out: ${stage}`);
    this.name = 'OAuthStageTimeoutError';
  }
}

export function withOAuthTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = schedule(() => reject(new OAuthStageTimeoutError(stage)), timeoutMs);
    promise.then(
      (value) => {
        cancel(timeout);
        resolve(value);
      },
      (error: unknown) => {
        cancel(timeout);
        reject(error);
      },
    );
  });
}

function hashCredential(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function callbackFingerprint(payload: OAuthCallbackPayload): string {
  switch (payload.type) {
    case 'code':
      return `code:${hashCredential(payload.code)}`;
    case 'fragment':
      return `fragment:${hashCredential(`${payload.accessToken}:${payload.refreshToken}`)}`;
    case 'error':
      return `error:${hashCredential(payload.error)}`;
    case 'invalid':
      return 'invalid';
  }
}

function isMatchingSession(
  session: Session | null,
  expected: { userId: string; accessToken?: string },
): session is Session {
  if (!session || session.user.id !== expected.userId) return false;
  return expected.accessToken === undefined || session.access_token === expected.accessToken;
}

function autoLinked(session: Session): boolean {
  const providers = new Set(
    (session.user.identities ?? []).map((identity) => identity.provider),
  );
  return providers.has('email') && providers.has('google');
}

function errorResult(
  reason: Extract<OAuthCompletionResult, { status: 'error' }>['reason'],
  message: string,
  isDuplicate = false,
): OAuthCompletionResult {
  return { status: 'error', reason, message, isDuplicate };
}

export class OAuthCompletionCoordinator {
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly exchangeTimeoutMs: number;
  private readonly reconcileTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly maxRememberedCallbacks: number;
  private readonly callbacks = new Map<string, Promise<OAuthCompletionResult>>();
  private activeAttempt: Attempt | null = null;
  private sequence = 0;

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.schedule = dependencies.timeout ?? setTimeout;
    this.cancel = dependencies.clearTimeout ?? clearTimeout;
    this.exchangeTimeoutMs = dependencies.exchangeTimeoutMs ?? OAUTH_EXCHANGE_TIMEOUT_MS;
    this.reconcileTimeoutMs = dependencies.reconcileTimeoutMs ?? OAUTH_RECONCILE_TIMEOUT_MS;
    this.navigationTimeoutMs = dependencies.navigationTimeoutMs ?? OAUTH_NAVIGATION_TIMEOUT_MS;
    this.maxRememberedCallbacks = dependencies.maxRememberedCallbacks ?? 32;
  }

  beginAttempt(intent: OAuthIntent, metadata: OAuthTelemetryMetadata): string {
    this.sequence += 1;
    const attempt: Attempt = {
      flowId: `oauth-${this.now().toString(36)}-${this.sequence.toString(36)}`,
      intent,
      startedAt: this.now(),
      metadata,
    };
    this.activeAttempt = attempt;
    this.emit('oauth_started', attempt);
    return attempt.flowId;
  }

  recordBrowserReturned(resultType: string): void {
    const attempt = this.activeAttempt;
    if (!attempt) return;
    this.emit('browser_returned', attempt, { result_type: resultType });
  }

  recordFailure(reason: string): void {
    const attempt = this.activeAttempt;
    if (!attempt) return;
    this.emit('oauth_failed', attempt, { failure_reason: reason });
    this.activeAttempt = null;
  }

  completeCallback(
    url: string,
    source: OAuthCallbackSource,
    runtime: OAuthCompletionRuntime,
  ): Promise<OAuthCompletionResult> {
    const payload = parseOAuthCallback(url);
    const fingerprint = callbackFingerprint(payload);
    const existing = this.callbacks.get(fingerprint);
    if (existing) return existing;

    const promise = Promise.resolve().then(() => (
      this.executeCallback(payload, fingerprint, source, runtime)
    ));
    this.callbacks.set(fingerprint, promise);
    while (this.callbacks.size > this.maxRememberedCallbacks) {
      const oldest = this.callbacks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.callbacks.delete(oldest);
    }
    return promise;
  }

  private attemptForCallback(
    fingerprint: string,
    metadata: OAuthTelemetryMetadata,
  ): Attempt {
    if (this.activeAttempt) return this.activeAttempt;
    const attempt: Attempt = {
      flowId: `callback-${fingerprint.split(':').at(-1)}`,
      intent: 'sign_in',
      startedAt: this.now(),
      metadata,
    };
    this.emit('oauth_started', attempt, { restored_callback: true });
    return attempt;
  }

  private async executeCallback(
    payload: OAuthCallbackPayload,
    fingerprint: string,
    source: OAuthCallbackSource,
    runtime: OAuthCompletionRuntime,
  ): Promise<OAuthCompletionResult> {
    const attempt = this.attemptForCallback(fingerprint, runtime.metadata);
    const transport = payload.type === 'fragment' ? 'fragment' : 'code';
    this.emit('callback_received', attempt, {
      callback_source: source,
      callback_transport: payload.type === 'code' || payload.type === 'fragment'
        ? payload.type
        : 'none',
    });

    if (payload.type === 'error') {
      this.emit('oauth_failed', attempt, { failure_reason: 'provider_error' });
      this.activeAttempt = null;
      return errorResult(
        'provider_error',
        payload.error === 'access_denied'
          ? 'Google sign-in was cancelled. You can try again when ready.'
          : 'Google could not complete sign-in. Please try again.',
      );
    }
    if (payload.type === 'invalid') {
      this.emit('oauth_failed', attempt, { failure_reason: 'invalid_callback' });
      this.activeAttempt = null;
      return errorResult(
        'invalid_callback',
        'FolioLens did not receive a valid Google sign-in callback. Please try again.',
      );
    }

    this.emit('session_started', attempt, { callback_transport: transport });

    let authResult: AuthResult;
    try {
      const providerPromise = payload.type === 'code'
        ? this.dependencies.provider.exchangeCodeForSession(payload.code)
        : this.dependencies.provider.setSession({
            access_token: payload.accessToken,
            refresh_token: payload.refreshToken,
          });
      authResult = await withOAuthTimeout(
        providerPromise,
        this.exchangeTimeoutMs,
        'session_exchange',
        this.schedule,
        this.cancel,
      );
    } catch (error) {
      const timedOut = error instanceof OAuthStageTimeoutError;
      this.emit('oauth_failed', attempt, {
        failure_reason: timedOut ? 'exchange_timeout' : 'exchange_failed',
      });
      this.activeAttempt = null;
      return errorResult(
        timedOut ? 'exchange_timeout' : 'exchange_failed',
        timedOut
          ? 'Google sign-in took too long to finish. Check your connection and try again.'
          : 'FolioLens could not finish Google sign-in. Check your connection and try again.',
      );
    }

    if (authResult.error || !authResult.data.session) {
      const duplicate = authResult.error?.message.toLowerCase().includes('already') ?? false;
      this.emit('oauth_failed', attempt, { failure_reason: 'exchange_failed' });
      this.activeAttempt = null;
      return errorResult(
        'exchange_failed',
        duplicate
          ? 'This Google identity is already connected to another FolioLens account.'
          : 'FolioLens could not finish Google sign-in. Check your connection and try again.',
        duplicate,
      );
    }

    const exchangedSession = authResult.data.session;
    const expected = {
      userId: exchangedSession.user.id,
      accessToken: exchangedSession.access_token,
    };
    let confirmedSession: Session;
    try {
      confirmedSession = await runtime.waitForSession(
        expected,
        OAUTH_SESSION_CONFIRM_TIMEOUT_MS,
      );
    } catch {
      try {
        const reconciled = await withOAuthTimeout(
          runtime.reconcileSession(),
          this.reconcileTimeoutMs,
          'session_reconciliation',
          this.schedule,
          this.cancel,
        );
        if (!isMatchingSession(reconciled, expected)) throw new Error('Session mismatch');
        confirmedSession = reconciled;
      } catch {
        this.emit('oauth_failed', attempt, {
          failure_reason: 'session_confirmation_failed',
        });
        this.activeAttempt = null;
        return errorResult(
          'session_confirmation_failed',
          'Google sign-in finished, but FolioLens could not confirm the session. Please try again.',
        );
      }
    }

    this.emit('session_confirmed', attempt, { callback_transport: transport });
    try {
      await withOAuthTimeout(
        Promise.resolve(runtime.navigateToTabs()),
        this.navigationTimeoutMs,
        'navigation',
        this.schedule,
        this.cancel,
      );
    } catch {
      this.emit('oauth_failed', attempt, { failure_reason: 'navigation_failed' });
      this.activeAttempt = null;
      return errorResult(
        'navigation_failed',
        'You are signed in, but FolioLens could not open your portfolio. Reopen the app to continue.',
      );
    }

    this.emit('navigation_completed', attempt, { callback_transport: transport });
    this.activeAttempt = null;
    return {
      status: 'success',
      transport,
      wasAutoLinked: autoLinked(confirmedSession),
    };
  }

  private emit(
    event: string,
    attempt: Attempt,
    extra: Record<string, unknown> = {},
  ): void {
    const properties = {
      ...attempt.metadata,
      flow_id: attempt.flowId,
      intent: attempt.intent,
      duration_ms: Math.max(0, this.now() - attempt.startedAt),
      ...extra,
    };
    // Release logcat evidence uses the same allowlisted payload as analytics.
    // Never add callback URLs, codes, tokens, email, or provider identity here.
    console.warn('[auth/oauth]', event, properties);
    this.dependencies.track(event, properties);
  }
}
