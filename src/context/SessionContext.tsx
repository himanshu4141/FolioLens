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

  useEffect(() => {
    let mounted = true;
    const deferred = bootstrapRef.current;
    const listeners = listenersRef.current;
    const bootstrapRevision = authRevisionRef.current;

    const {
      data: { subscription },
    } = authClient.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      authRevisionRef.current += 1;
      sessionRef.current = nextSession;
      setSession(nextSession);
      setLoading(false);
      deferred?.resolve();
      for (const listener of listeners) {
        listener(event, nextSession);
      }
    });

    void authClient.getSession()
      .then(({ data }) => {
        if (!mounted || authRevisionRef.current !== bootstrapRevision) return;
        sessionRef.current = data.session;
        setSession(data.session);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!mounted || authRevisionRef.current !== bootstrapRevision) return;
        console.warn('[auth] session bootstrap failed', error);
        sessionRef.current = null;
        setSession(null);
        setLoading(false);
      })
      .finally(() => {
        deferred?.resolve();
      });

    return () => {
      mounted = false;
      deferred?.resolve();
      subscription.unsubscribe();
      listeners.clear();
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ session, loading, getCurrentSession, subscribeToAuth }),
    [session, loading, getCurrentSession, subscribeToAuth],
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
