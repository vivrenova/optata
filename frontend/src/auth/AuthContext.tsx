import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  api,
  ApiError,
  apiJson,
  bootstrapSession,
  errorDetail,
  NETWORK_ERROR_MESSAGE,
  onSessionExpired,
  setAccessToken,
} from "../api/client";
import type { TokenOut, UserPrivate } from "../api/client";

interface AuthContextValue {
  /** null = guest. Access token itself never leaves the api module. */
  user: UserPrivate | null;
  /** True until the mount-time refresh settles — render a splash, never a
   * flash of logged-out UI. */
  booting: boolean;
  login(email: string, password: string): Promise<UserPrivate>;
  register(email: string, username: string, password: string): Promise<UserPrivate>;
  logout(): Promise<void>;
  /** For later stages (settings) to push updated profile data. */
  setUser(user: UserPrivate | null): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function credentialCall(path: string, body: object): Promise<TokenOut> {
  let response: Response;
  try {
    response = await api(path, { method: "POST", body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // keep fallback
    }
    throw new ApiError(
      response.status,
      errorDetail(parsed, "The server had a problem with that. Try again."),
    );
  }
  return (await response.json()) as TokenOut;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPrivate | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    onSessionExpired(() => setUser(null));
    // bootstrapSession is module-level single-flight: StrictMode's double
    // invocation of this effect still produces exactly one network call.
    void bootstrapSession().then((data) => {
      if (!cancelled) {
        setUser(data?.user ?? null);
        setBooting(false);
      }
    });
    return () => {
      cancelled = true;
      onSessionExpired(null);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await credentialCall("/auth/login", { email, password });
    setAccessToken(data.access_token);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(
    async (email: string, username: string, password: string) => {
      const data = await credentialCall("/auth/register", { email, username, password });
      setAccessToken(data.access_token);
      setUser(data.user);
      return data.user;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await apiJson<void>("/auth/logout", { method: "POST" });
    } catch {
      // even if the server call fails, the local session ends
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, booting, login, register, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
