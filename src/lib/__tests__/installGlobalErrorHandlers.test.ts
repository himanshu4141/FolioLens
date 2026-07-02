interface ErrorUtilsStub {
  getGlobalHandler: () => (error: Error, isFatal?: boolean) => void;
  setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
}

const runtimeGlobal = globalThis as typeof globalThis & { ErrorUtils?: ErrorUtilsStub };

describe('installGlobalErrorHandlers', () => {
  afterEach(() => {
    delete runtimeGlobal.ErrorUtils;
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('installs the native wrapper when analytics is disabled', async () => {
    const previousHandler = jest.fn();
    const setGlobalHandler = jest.fn();
    const captureException = jest.fn();
    runtimeGlobal.ErrorUtils = {
      getGlobalHandler: () => previousHandler,
      setGlobalHandler,
    };

    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true });
    jest.doMock('@/src/lib/analytics', () => ({
      analytics: {
        isEnabled: false,
        track: jest.fn(),
        identify: jest.fn(),
        reset: jest.fn(),
        captureException,
      },
    }));

    const { installGlobalErrorHandlers } = await import('@/src/lib/installGlobalErrorHandlers');
    installGlobalErrorHandlers();

    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
    const installedHandler = setGlobalHandler.mock.calls[0]?.[0];
    expect(installedHandler).toBeDefined();

    const error = new Error('test failure');
    installedHandler?.(error, true);
    expect(captureException).toHaveBeenCalledWith(error, {
      $exception_source: 'react_native_error_utils',
      is_fatal: true,
    });
    expect(previousHandler).toHaveBeenCalledWith(error, true);
  });
});
