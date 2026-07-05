import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  authClient,
  type AuthChangeEvent,
  type Session,
} from '@/src/lib/auth';

type SessionEventListener = (
  event: AuthChangeEvent,
  session: Session | null,
) => void;

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  getCurrentSession: () => Promise<Session | null>;
  subscribeToAuth: (listener: SessionEventListener) => () => void;
  waitForSession: (
    expected: SessionExpectation,
    timeoutMs: number,
  ) => Promise<Session>;
  reconcileSession: () => Promise<Session | null>;
}

export interface SessionExpectation {
  userId: string;
  accessToken?: string;
}

interface SessionWaiter {
  expected: SessionExpectation;
  resolve: (session: Session) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DeferredSession {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferredSession(): DeferredSession {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const SessionContext = createContext<SessionContextValue | null>(null);

function sessionMatches(
  session: Session | null,
  expected: SessionExpectation,
): session is Session {
  if (!session || session.user.id !== expected.userId) return false;
  return expected.accessToken === undefined || session.access_token === expected.accessToken;
}

/**
 * Owns the app process's single Supabase session bootstrap and auth listener.
 *
 * The lifecycle controller subscribes to the in-process event stream exposed
 * here. It therefore observes the same auth events as React consumers without
 * registering a second provider listener or issuing another getSession call.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionRef = useRef<Session | null>(null);
  const authRevisionRef = useRef(0);
  const listenersRef = useRef(new Set<SessionEventListener>());
  const waitersRef = useRef(new Set<SessionWaiter>());
  const bootstrapRef = useRef<DeferredSession | null>(null);

  if (bootstrapRef.current === null) {
    bootstrapRef.current = createDeferredSession();
  }

  const getCurrentSession = useCallback(async () => {
    await bootstrapRef.current?.promise;
    return sessionRef.current;
  }, []);

  const subscribeToAuth = useCallback((listener: SessionEventListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  const applySession = useCallback((nextSession: Session | null) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
    setLoading(false);

    for (const waiter of waitersRef.current) {
      if (!sessionMatches(nextSession, waiter.expected)) continue;
      clearTimeout(waiter.timeout);
      waitersRef.current.delete(waiter);
      waiter.resolve(nextSession);
    }
  }, []);

  const waitForSession = useCallback((
    expected: SessionExpectation,
    timeoutMs: number,
  ): Promise<Session> => {
    const current = sessionRef.current;
    if (sessionMatches(current, expected)) return Promise.resolve(current);

    return new Promise<Session>((resolve, reject) => {
      const waiter = {} as SessionWaiter;
      waiter.expected = expected;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timeout = setTimeout(() => {
        waitersRef.current.delete(waiter);
        reject(new Error('Timed out waiting for the shared session state.'));
      }, timeoutMs);
      waitersRef.current.add(waiter);
    });
  }, []);

  const reconcileSession = useCallback(async (): Promise<Session | null> => {
    const reconcileRevision = authRevisionRef.current;
    const { data, error } = await authClient.getSession();
    if (error) throw error;
    if (authRevisionRef.current !== reconcileRevision) return sessionRef.current;
    applySession(data.session);
    return data.session;
  }, [applySession]);

  useEffect(() => {
    let mounted = true;
    const deferred = bootstrapRef.current;
    const listeners = listenersRef.current;
    const waiters = waitersRef.current;
    const bootstrapRevision = authRevisionRef.current;

    const {
      data: { subscription },
    } = authClient.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      authRevisionRef.current += 1;
      applySession(nextSession);
      deferred?.resolve();
      for (const listener of listeners) {
        listener(event, nextSession);
      }
    });

    void authClient.getSession()
      .then(({ data }) => {
        if (!mounted || authRevisionRef.current !== bootstrapRevision) return;
        applySession(data.session);
      })
      .catch((error: unknown) => {
        if (!mounted || authRevisionRef.current !== bootstrapRevision) return;
        console.warn('[auth] session bootstrap failed', error);
        applySession(null);
      })
      .finally(() => {
        deferred?.resolve();
      });

    return () => {
      mounted = false;
      deferred?.resolve();
      subscription.unsubscribe();
      listeners.clear();
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error('SessionProvider unmounted before confirmation.'));
      }
      waiters.clear();
    };
  }, [applySession]);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      loading,
      getCurrentSession,
      subscribeToAuth,
      waitForSession,
      reconcileSession,
    }),
    [
      session,
      loading,
      getCurrentSession,
      subscribeToAuth,
      waitForSession,
      reconcileSession,
    ],
  );

  return createElement(SessionContext.Provider, { value }, children);
}

export function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return value;
}
