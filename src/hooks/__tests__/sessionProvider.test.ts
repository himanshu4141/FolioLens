import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SessionProvider } from '@/src/context/SessionContext';
import { useSession } from '@/src/hooks/useSession';
import { authClient } from '@/src/lib/auth';

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

function SessionConsumer({ onRender }: { onRender: (loading: boolean) => void }) {
  const { loading } = useSession();
  onRender(loading);
  return null;
}

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
      expect(onRender).toHaveBeenCalledWith(false);
    }

    act(() => renderer?.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
