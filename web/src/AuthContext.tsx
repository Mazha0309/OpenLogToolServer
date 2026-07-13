import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, clearAuth, refreshAccess, subscribeAuth } from './api';
import type { AuthSession, User } from './types';

interface AuthContextValue {
  user: User | null;
  initializing: boolean;
  login: (username: string, password: string) => Promise<User>;
  register: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => subscribeAuth((session: AuthSession | null) => setUser(session?.user ?? null)), []);

  useEffect(() => {
    let active = true;
    refreshAccess()
      .then((session) => { if (active) setUser(session.user); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setInitializing(false); });
    return () => { active = false; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const session = await authApi.login(username, password);
    setUser(session.user);
    return session.user;
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const session = await authApi.register(username, password);
    setUser(session.user);
    return session.user;
  }, []);

  const logout = useCallback(async () => {
    try { await authApi.logout(); } finally { clearAuth(); setUser(null); }
  }, []);

  const refreshUser = useCallback(async () => setUser(await authApi.me()), []);

  const value = useMemo(
    () => ({ user, initializing, login, register, logout, refreshUser }),
    [user, initializing, login, register, logout, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// oxlint-disable-next-line react/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
