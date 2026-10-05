import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  loading: boolean;
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
  const [syncError, setSyncError] = useState<string | null>(null);

  const syncRounds = useCallback(async () => {
    try {
      await migrateLocalIfNeeded();
      setSyncError(null);
    } catch (err) {
      console.error(err);
      setSyncError(`对局记录同步失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const signedOut = useCallback(() => {
    setUser(null);
    setRoundsCache([]);
    setSyncError(null);
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
    setUser(me);
    await syncRounds();
  }, [loadMe, signedOut, syncRounds]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await loadMe();
      if (cancelled) return;
      if (me) {
        setUser(me);
        await syncRounds();
      } else {
        signedOut();
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe, signedOut, syncRounds]);

  const login = useCallback(
    async (username: string, password: string) => {
      const me = await loginUser(username, password);
      setUser(me);
      await syncRounds();
    },
    [syncRounds],
  );

  const register = useCallback(
    async (username: string, password: string) => {
      const me = await registerUser(username, password);
      setUser(me);
      await syncRounds();
    },
    [syncRounds],
  );

  const logout = useCallback(async () => {
    try {
      await logoutUser();
    } finally {
      signedOut();
    }
  }, [signedOut]);

  const value = useMemo(
    () => ({ user, loading, syncError, login, register, logout, refresh, retrySync: syncRounds }),
    [user, loading, syncError, login, register, logout, refresh, syncRounds],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
