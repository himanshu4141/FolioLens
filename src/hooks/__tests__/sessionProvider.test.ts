import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SessionProvider } from '@/src/context/SessionContext';
import { useSession } from '@/src/hooks/useSession';
import { authClient, type AuthChangeEvent, type Session } from '@/src/lib/auth';

jest.mock('@/src/lib/auth', () => ({
  authClient: {
    getSession: jest.fn(),
    onAuthStateChange: jest.fn(),
  },
}));

const mockedGetSession = authClient.getSession as jest.MockedFunction<
  typeof authClient.getSession
>;
const mockedOnAuthStateChange = authClient.onAuthStateChange as jest.MockedFunction<
  typeof authClient.onAuthStateChange
>;

function SessionConsumer({
  onRender,
}: {
  onRender: (loading: boolean, session: Session | null) => void;
}) {
  const { loading, session } = useSession();
  onRender(loading, session);
  return null;
}

function SessionApiConsumer({
  onReady,
}: {
  onReady: (value: ReturnType<typeof useSession>) => void;
}) {
  const value = useSession();
  onReady(value);
  return null;
}

function deferredSessionResult() {
  let resolve = (_result: Awaited<ReturnType<typeof authClient.getSession>>) => {};
  const promise = new Promise<Awaited<ReturnType<typeof authClient.getSession>>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const NEW_SESSION = {
  access_token: 'new-token',
  refresh_token: 'new-refresh',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'new-user' },
} as Session;

const OLD_SESSION = {
  ...NEW_SESSION,
  access_token: 'old-token',
  user: { id: 'old-user' },
} as Session;

describe('SessionProvider', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shares one auth bootstrap and one underlying subscription across consumers', async () => {
    const unsubscribe = jest.fn();
    mockedGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mockedOnAuthStateChange.mockReturnValue({
      data: { subscription: { id: 'session-test', callback: jest.fn(), unsubscribe } },
    });
    const renders = [jest.fn(), jest.fn(), jest.fn()];
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          ...renders.map((onRender, index) => React.createElement(SessionConsumer, {
            key: index,
            onRender,
          })),
        ),
      );
      await Promise.resolve();
    });

    expect(mockedGetSession).toHaveBeenCalledTimes(1);
    expect(mockedOnAuthStateChange).toHaveBeenCalledTimes(1);
    for (const onRender of renders) {
      expect(onRender).toHaveBeenCalledWith(false, null);
    }

    act(() => renderer?.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('restores an existing session on cold mount without another auth source', async () => {
    mockedGetSession.mockResolvedValue({
      data: { session: NEW_SESSION },
      error: null,
    });
    mockedOnAuthStateChange.mockReturnValue({
      data: {
        subscription: { id: 'cold-restore', callback: jest.fn(), unsubscribe: jest.fn() },
      },
    });
    const renders = jest.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          React.createElement(SessionConsumer, { onRender: renders }),
        ),
      );
      await Promise.resolve();
    });

    expect(renders.mock.calls.at(-1)).toEqual([false, NEW_SESSION]);
    expect(mockedGetSession).toHaveBeenCalledTimes(1);
    expect(mockedOnAuthStateChange).toHaveBeenCalledTimes(1);
    act(() => renderer?.unmount());
  });

  it('does not let a late null bootstrap overwrite a newer SIGNED_IN event', async () => {
    const bootstrap = deferredSessionResult();
    let authCallback:
      | ((event: AuthChangeEvent, session: Session | null) => void)
      | undefined;
    mockedGetSession.mockReturnValue(bootstrap.promise);
    mockedOnAuthStateChange.mockImplementation((callback) => {
      authCallback = callback;
      return {
        data: {
          subscription: { id: 'signin-race', callback, unsubscribe: jest.fn() },
        },
      };
    });
    const renders = jest.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          React.createElement(SessionConsumer, { onRender: renders }),
        ),
      );
    });

    act(() => authCallback?.('SIGNED_IN', NEW_SESSION));
    expect(renders.mock.calls.at(-1)).toEqual([false, NEW_SESSION]);

    await act(async () => {
      bootstrap.resolve({ data: { session: null }, error: null });
      await bootstrap.promise;
    });
    expect(renders.mock.calls.at(-1)).toEqual([false, NEW_SESSION]);
    act(() => renderer?.unmount());
  });

  it('does not let a late old bootstrap resurrect a newer SIGNED_OUT event', async () => {
    const bootstrap = deferredSessionResult();
    let authCallback:
      | ((event: AuthChangeEvent, session: Session | null) => void)
      | undefined;
    mockedGetSession.mockReturnValue(bootstrap.promise);
    mockedOnAuthStateChange.mockImplementation((callback) => {
      authCallback = callback;
      return {
        data: {
          subscription: { id: 'signout-race', callback, unsubscribe: jest.fn() },
        },
      };
    });
    const renders = jest.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          React.createElement(SessionConsumer, { onRender: renders }),
        ),
      );
    });

    act(() => authCallback?.('SIGNED_OUT', null));
    expect(renders.mock.calls.at(-1)).toEqual([false, null]);

    await act(async () => {
      bootstrap.resolve({ data: { session: OLD_SESSION }, error: null });
      await bootstrap.promise;
    });
    expect(renders.mock.calls.at(-1)).toEqual([false, null]);
    act(() => renderer?.unmount());
  });

  it('confirms the exact session from the shared auth event without another getSession', async () => {
    let authCallback:
      | ((event: AuthChangeEvent, session: Session | null) => void)
      | undefined;
    mockedGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockedOnAuthStateChange.mockImplementation((callback) => {
      authCallback = callback;
      return {
        data: {
          subscription: { id: 'confirmation', callback, unsubscribe: jest.fn() },
        },
      };
    });
    let api: ReturnType<typeof useSession> | undefined;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          React.createElement(SessionApiConsumer, {
            onReady: (value) => { api = value; },
          }),
        ),
      );
      await Promise.resolve();
    });

    const confirmation = api?.waitForSession(
      { userId: NEW_SESSION.user.id, accessToken: NEW_SESSION.access_token },
      1000,
    );
    act(() => authCallback?.('SIGNED_IN', NEW_SESSION));

    await expect(confirmation).resolves.toBe(NEW_SESSION);
    expect(mockedGetSession).toHaveBeenCalledTimes(1);
    act(() => renderer?.unmount());
  });

  it('reconciles a persisted session through the same provider state', async () => {
    mockedGetSession
      .mockResolvedValueOnce({ data: { session: null }, error: null })
      .mockResolvedValueOnce({ data: { session: NEW_SESSION }, error: null });
    mockedOnAuthStateChange.mockReturnValue({
      data: {
        subscription: { id: 'reconcile', callback: jest.fn(), unsubscribe: jest.fn() },
      },
    });
    let api: ReturnType<typeof useSession> | undefined;
    const renders = jest.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          React.createElement(SessionApiConsumer, {
            onReady: (value) => { api = value; },
          }),
          React.createElement(SessionConsumer, { onRender: renders }),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      await expect(api?.reconcileSession()).resolves.toBe(NEW_SESSION);
    });

    expect(mockedGetSession).toHaveBeenCalledTimes(2);
    expect(renders.mock.calls.at(-1)).toEqual([false, NEW_SESSION]);
    act(() => renderer?.unmount());
  });

  it('does not let late reconciliation overwrite a newer auth event', async () => {
    const reconciliation = deferredSessionResult();
    let authCallback:
      | ((event: AuthChangeEvent, session: Session | null) => void)
      | undefined;
    mockedGetSession
      .mockResolvedValueOnce({ data: { session: NEW_SESSION }, error: null })
      .mockReturnValueOnce(reconciliation.promise);
    mockedOnAuthStateChange.mockImplementation((callback) => {
      authCallback = callback;
      return {
        data: {
          subscription: { id: 'reconcile-race', callback, unsubscribe: jest.fn() },
        },
      };
    });
    let api: ReturnType<typeof useSession> | undefined;
    const renders = jest.fn();
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          SessionProvider,
          null,
          React.createElement(SessionApiConsumer, {
            onReady: (value) => { api = value; },
          }),
          React.createElement(SessionConsumer, { onRender: renders }),
        ),
      );
      await Promise.resolve();
    });

    const reconciled = api?.reconcileSession();
    act(() => authCallback?.('SIGNED_OUT', null));
    await act(async () => {
      reconciliation.resolve({ data: { session: OLD_SESSION }, error: null });
      await reconciliation.promise;
    });

    await expect(reconciled).resolves.toBeNull();
    expect(renders.mock.calls.at(-1)).toEqual([false, null]);
    act(() => renderer?.unmount());
  });
});
