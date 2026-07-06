import {
  runNativeGoogleOAuth,
  type NativeGoogleOAuthController,
} from '@/src/lib/nativeGoogleOAuth';

function createController(): jest.Mocked<NativeGoogleOAuthController> {
  return {
    beginAttempt: jest.fn().mockReturnValue('safe-flow-id'),
    recordBrowserReturned: jest.fn(),
    recordFailure: jest.fn(),
    completeCallback: jest.fn().mockResolvedValue({
      status: 'success',
      transport: 'code',
      wasAutoLinked: false,
    }),
  };
}

const immediateTimeout = ((callback: () => void) => {
  callback();
  return 1 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
const noopClearTimeout = (() => {}) as typeof clearTimeout;

describe('runNativeGoogleOAuth', () => {
  it('completes a successful browser callback through the shared controller', async () => {
    const controller = createController();
    const result = await runNativeGoogleOAuth({
      intent: 'sign_in',
      controller,
      createAuthorizationUrl: async () => 'https://auth.example/start',
      openBrowser: async () => ({
        type: 'success',
        url: 'foliolens-pr://auth/callback?code=callback-code',
      }),
      dismissBrowser: jest.fn(),
    });

    expect(result.status).toBe('success');
    expect(controller.beginAttempt).toHaveBeenCalledWith('sign_in');
    expect(controller.recordBrowserReturned).toHaveBeenCalledWith('success');
    expect(controller.completeCallback).toHaveBeenCalledWith(
      'foliolens-pr://auth/callback?code=callback-code',
      'web_browser',
    );
  });

  it.each(['cancel', 'dismiss'])('returns explicit cancellation for browser %s', async (type) => {
    const controller = createController();
    const result = await runNativeGoogleOAuth({
      intent: 'sign_in',
      controller,
      createAuthorizationUrl: async () => 'https://auth.example/start',
      openBrowser: async () => ({ type }),
      dismissBrowser: jest.fn(),
    });

    expect(result.status).toBe('cancelled');
    expect(controller.recordBrowserReturned).toHaveBeenCalledWith(type);
    expect(controller.recordFailure).toHaveBeenCalledWith(`browser_${type}`);
    expect(controller.completeCallback).not.toHaveBeenCalled();
  });

  it('terminates when OAuth URL creation times out', async () => {
    const controller = createController();
    const result = await runNativeGoogleOAuth({
      intent: 'sign_in',
      controller,
      createAuthorizationUrl: () => new Promise(() => {}),
      openBrowser: jest.fn(),
      dismissBrowser: jest.fn(),
      timeout: immediateTimeout,
      clearTimeout: noopClearTimeout,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'url_creation_timeout' });
    expect(controller.recordFailure).toHaveBeenCalledWith('url_creation_timeout');
  });

  it('dismisses a stuck browser when callback return times out', async () => {
    const controller = createController();
    const dismissBrowser = jest.fn();
    let timeoutCount = 0;
    const secondImmediateTimeout = ((callback: () => void) => {
      timeoutCount += 1;
      if (timeoutCount === 2) callback();
      return timeoutCount as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const result = await runNativeGoogleOAuth({
      intent: 'sign_in',
      controller,
      createAuthorizationUrl: async () => 'https://auth.example/start',
      openBrowser: () => new Promise(() => {}),
      dismissBrowser,
      timeout: secondImmediateTimeout,
      clearTimeout: noopClearTimeout,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'browser_timeout' });
    expect(dismissBrowser).toHaveBeenCalledTimes(1);
    expect(controller.recordFailure).toHaveBeenCalledWith('browser_timeout');
  });

  it('keeps waiting across a consent background interval and consumes the later callback', async () => {
    const controller = createController();
    let returnFromBrowser: ((value: {
      type: string;
      url: string;
    }) => void) | undefined;
    const browser = new Promise<{ type: string; url: string }>((resolve) => {
      returnFromBrowser = resolve;
    });
    const outcome = runNativeGoogleOAuth({
      intent: 'link_identity',
      controller,
      createAuthorizationUrl: async () => 'https://auth.example/start',
      openBrowser: () => browser,
      dismissBrowser: jest.fn(),
    });

    await Promise.resolve();
    expect(controller.completeCallback).not.toHaveBeenCalled();
    returnFromBrowser?.({
      type: 'success',
      url: 'foliolens-pr://auth/callback?code=after-foreground',
    });

    await expect(outcome).resolves.toMatchObject({ status: 'success' });
    expect(controller.beginAttempt).toHaveBeenCalledWith('link_identity');
  });
});
