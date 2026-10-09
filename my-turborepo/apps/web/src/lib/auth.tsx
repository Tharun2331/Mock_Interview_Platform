import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { fetchMe } from "@/lib/authApi";
import { onAuthEvent } from "@/lib/authEvents";

// Mirrors the four auth conditions a screen can be in: bootstrapping (loading),
// signed out, signed in, and expired-mid-session (treated as signed out — the
// API client reports `expired` when a refresh fails, e.g. after 7 days or a
// revoked session).
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

const AuthContext = createContext<AuthStatus | undefined>(undefined);

// This provider reports status only; it never navigates. Routing decisions live
// in the RequireAuth / RedirectIfAuthenticated guards.
//
// The session is an httpOnly cookie (ADR-0011), which page script cannot read,
// so "is anyone signed in?" is a question for the server. GET /auth/me answers
// it, renewing a lapsed access token on the way (lib/api.ts), so a candidate
// returning within the refresh token's 7 days is still signed in.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let active = true;

    // Subscribed before the bootstrap read, and an event wins over it: a
    // sign-in that settles while /me is still in flight must not be
    // overwritten by /me's older answer.
    let settledByEvent = false;
    const unsubscribe = onAuthEvent((event) => {
      settledByEvent = true;
      setStatus(event === "signedIn" ? "authenticated" : "unauthenticated");
    });

    fetchMe()
      .then(() => {
        if (active && !settledByEvent) setStatus("authenticated");
      })
      .catch(() => {
        if (active && !settledByEvent) setStatus("unauthenticated");
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={status}>{children}</AuthContext.Provider>;
}

export function useAuthStatus(): AuthStatus {
  const status = useContext(AuthContext);
  if (status === undefined) {
    throw new Error("useAuthStatus must be used within an AuthProvider");
  }
  return status;
}
