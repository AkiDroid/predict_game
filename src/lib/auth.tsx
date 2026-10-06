import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  fetchMe,
  loginUser,
  logoutUser,
  registerUser,
  type AuthUser,
} from './api';
import { migrateLocalIfNeeded, setRoundsCache } from './storage';

type AuthState = {
  user: AuthUser | null;
  /** True until /api/auth/me settles. Round history may still be syncing afterwards. */
  loading: boolean;
  /** False while the round history sync started by sign-in is in flight (success or failure ends it). */
  roundsSettled: boolean;
  /** Set when the session is fine but loading or migrating round history failed. */
  syncError: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  retrySync: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [roundsSettled, setRoundsSettled] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  /** Bumped on every sync start and sign-out so a stale sync cannot overwrite newer state. */
  const syncSeq = useRef(0);
  const signedIn = useRef(false);

  /** `initial` marks the first sync after sign-in; only that one holds back cache-reading routes. */
  const runSync = useCallback(async (initial: boolean) => {
    const seq = ++syncSeq.current;
    if (initial) setRoundsSettled(false);
    try {
      await migrateLocalIfNeeded();
      if (seq === syncSeq.current) setSyncError(null);
    } catch (err) {
      console.error(err);
      if (seq === syncSeq.current) {
        setSyncError(`对局记录同步失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (seq === syncSeq.current) setRoundsSettled(true);
    }
  }, []);

  const syncRounds = useCallback(() => runSync(false), [runSync]);

  const signedOut = useCallback(() => {
    syncSeq.current++;
    signedIn.current = false;
    setUser(null);
    setRoundsCache([]);
    setSyncError(null);
    setRoundsSettled(true);
  }, []);

  /** Only a 401 from /api/auth/me means signed out; other failures keep the current state. */
  const loadMe = useCallback(async (): Promise<AuthUser | null | undefined> => {
    try {
      return await fetchMe();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      console.error(err);
      return undefined;
    }
  }, []);

  const refresh = useCallback(async () => {
    const me = await loadMe();
    if (me === undefined) return;
    if (me === null) {
      signedOut();
      return;
    }
    const initial = !signedIn.current;
    setUser(me);
    signedIn.current = true;
    await runSync(initial);
  }, [loadMe, signedOut, runSync]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await loadMe();
      if (cancelled) return;
      if (me) {
        setUser(me);
        signedIn.current = true;
        // The history sync can be slow for large accounts; routes that read the round cache
        // synchronously wait for `roundsSettled` (see RequireAuth) instead of the whole app.
        void runSync(true);
      } else {
        signedOut();
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, signedOut, runSync]);

  const login = useCallback(
    async (username: string, password: string) => {
      const me = await loginUser(username, password);
      setUser(me);
      signedIn.current = true;
      void runSync(true);
    },
    [runSync],
  );

  const register = useCallback(
    async (username: string, password: string) => {
      const me = await registerUser(username, password);
      setUser(me);
      signedIn.current = true;
      void runSync(true);
    },
    [runSync],
  );

  const logout = useCallback(async () => {
    try {
      await logoutUser();
    } finally {
      signedOut();
    }
  }, [signedOut]);

  const value = useMemo(
    () => ({
      user,
      loading,
      roundsSettled,
      syncError,
      login,
      register,
      logout,
      refresh,
      retrySync: syncRounds,
    }),
    [user, loading, roundsSettled, syncError, login, register, logout, refresh, syncRounds],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
