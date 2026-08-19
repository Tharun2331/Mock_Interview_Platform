import { Navigate, Outlet } from "react-router";
import { useAuthStatus } from "@/lib/auth";
import { MESSAGES } from "@/lib/messages";

// The inverse of RequireAuth. Amplify persists tokens in localStorage, so a
// session survives a browser restart — without this guard a returning user
// lands on /signup still signed in, and clicking "Continue with Google" throws
// UserAlreadyAuthenticatedException instead of signing them in.
export function RedirectIfAuthenticated() {
  const status = useAuthStatus();

  // Render nothing while bootstrapping so the sign-in form doesn't flash before
  // the redirect. getCurrentUser() resolves without a network call when no
  // tokens are stored, so a genuine first-time visitor waits imperceptibly.
  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/form" replace />;
  }

  return <Outlet />;
}
