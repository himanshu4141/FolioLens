import {
  OAuthStageTimeoutError,
  withOAuthTimeout,
  type OAuthCallbackSource,
  type OAuthCompletionResult,
  type OAuthIntent,
} from '@/src/lib/oauthCompletion';

export const OAUTH_URL_TIMEOUT_MS = 15_000;
export const OAUTH_BROWSER_TIMEOUT_MS = 120_000;

interface BrowserResult {
  type: string;
  url?: string;
}

export interface NativeGoogleOAuthController {
  beginAttempt(intent: OAuthIntent): string;
  recordBrowserReturned(resultType: string): void;
  recordFailure(reason: string): void;
  completeCallback(
    url: string,
    source: OAuthCallbackSource,
  ): Promise<OAuthCompletionResult>;
}

export type NativeGoogleOAuthResult =
  | OAuthCompletionResult
  | { status: 'cancelled'; message: string }
  | {
    status: 'error';
    reason: 'url_creation_failed' | 'url_creation_timeout' | 'browser_failed' | 'browser_timeout';
    message: string;
    isDuplicate: false;
  };

interface NativeGoogleOAuthDependencies {
  intent: OAuthIntent;
  controller: NativeGoogleOAuthController;
  createAuthorizationUrl: () => Promise<string>;
  openBrowser: (url: string) => Promise<BrowserResult>;
  dismissBrowser: () => void | Promise<unknown>;
  urlTimeoutMs?: number;
  browserTimeoutMs?: number;
  timeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

function terminalError(
  reason: Extract<NativeGoogleOAuthResult, { status: 'error' }>['reason'],
  message: string,
): NativeGoogleOAuthResult {
  return { status: 'error', reason, message, isDuplicate: false };
}

export async function runNativeGoogleOAuth(
  dependencies: NativeGoogleOAuthDependencies,
): Promise<NativeGoogleOAuthResult> {
  const schedule = dependencies.timeout ?? setTimeout;
  const cancel = dependencies.clearTimeout ?? clearTimeout;
  dependencies.controller.beginAttempt(dependencies.intent);

  let authorizationUrl: string;
  try {
    authorizationUrl = await withOAuthTimeout(
      dependencies.createAuthorizationUrl(),
      dependencies.urlTimeoutMs ?? OAUTH_URL_TIMEOUT_MS,
      'url_creation',
      schedule,
      cancel,
    );
  } catch (error) {
    const timedOut = error instanceof OAuthStageTimeoutError;
    dependencies.controller.recordFailure(
      timedOut ? 'url_creation_timeout' : 'url_creation_failed',
    );
    return terminalError(
      timedOut ? 'url_creation_timeout' : 'url_creation_failed',
      timedOut
        ? 'Google sign-in took too long to start. Check your connection and try again.'
        : 'FolioLens could not start Google sign-in. Please try again.',
    );
  }

  let browserResult: BrowserResult;
  try {
    browserResult = await withOAuthTimeout(
      dependencies.openBrowser(authorizationUrl),
      dependencies.browserTimeoutMs ?? OAUTH_BROWSER_TIMEOUT_MS,
      'browser_return',
      schedule,
      cancel,
    );
  } catch (error) {
    const timedOut = error instanceof OAuthStageTimeoutError;
    if (timedOut) {
      try {
        await dependencies.dismissBrowser();
      } catch {
        // The Android polyfill may already have closed itself while timing out.
      }
    }
    dependencies.controller.recordFailure(timedOut ? 'browser_timeout' : 'browser_failed');
    return terminalError(
      timedOut ? 'browser_timeout' : 'browser_failed',
      timedOut
        ? 'Google sign-in timed out. Close the browser if it is still open, then try again.'
        : 'FolioLens could not open Google sign-in. Please try again.',
    );
  }

  dependencies.controller.recordBrowserReturned(browserResult.type);

  if (browserResult.type === 'cancel' || browserResult.type === 'dismiss') {
    dependencies.controller.recordFailure(`browser_${browserResult.type}`);
    return {
      status: 'cancelled',
      message: 'Google sign-in was cancelled. You can try again when ready.',
    };
  }

  if (browserResult.type !== 'success' || !browserResult.url) {
    dependencies.controller.recordFailure('browser_failed');
    return terminalError(
      'browser_failed',
      'Google sign-in returned without a valid callback. Please try again.',
    );
  }

  return dependencies.controller.completeCallback(browserResult.url, 'web_browser');
}
