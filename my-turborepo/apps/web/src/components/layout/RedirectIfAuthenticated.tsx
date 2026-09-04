import { Navigate, Outlet } from "react-router";
import { PresenceOrb } from "@/components/PresenceOrb";
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
      <div className="flex h-screen w-full flex-col items-center justify-center gap-5 bg-background">
        <PresenceOrb
          hue="var(--cue)"
          className="size-12 animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (status === "authenticated") {
    return <Navigate to="/form" replace />;
  }

  return <Outlet />;
}
