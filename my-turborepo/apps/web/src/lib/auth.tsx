import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";

// Mirrors the four auth conditions a screen can be in: bootstrapping (loading),
// signed out, signed in, and expired-mid-session (treated as signed out —
// tokenRefresh_failure fires when a refresh token can no longer renew the
// session, e.g. after 30 days or a revoked session).
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

const AuthContext = createContext<AuthStatus | undefined>(undefined);

// This provider reports status only; it never navigates. Routing decisions live
// in the RequireAuth / RedirectIfAuthenticated guards, because a redirect fired
// from here would also hijack the confirm page's signOut -> signIn sequence.
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    getCurrentUser()
      .then(() => setStatus("authenticated"))
      .catch(() => setStatus("unauthenticated"));

    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      switch (payload.event) {
        // The hosted-UI (Google) redirect settles as its own event and does NOT
        // also emit `signedIn`. Without this case the provider stays
        // "unauthenticated" after a successful Google login, and RequireAuth
        // bounces the user straight back to /signin.
        case "signedIn":
        case "signInWithRedirect":
          setStatus("authenticated");
          break;
        case "signedOut":
        case "signInWithRedirect_failure":
        case "tokenRefresh_failure":
          setStatus("unauthenticated");
          break;
      }
    });

    return unsubscribe;
  }, []);

  return (
    <AuthContext.Provider value={status}>{children}</AuthContext.Provider>
  );
}

export function useAuthStatus(): AuthStatus {
  const status = useContext(AuthContext);
  if (status === undefined) {
    throw new Error("useAuthStatus must be used within an AuthProvider");
  }
  return status;
}
