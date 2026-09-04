import { Navigate, Outlet } from "react-router";
import { PresenceOrb } from "@/components/PresenceOrb";
import { useAuthStatus } from "@/lib/auth";
import { MESSAGES } from "@/lib/messages";

export function RequireAuth() {
  const status = useAuthStatus();

  if (status === "loading") {
    return (
      // Bootstrapping is one of auth's four renderable conditions, and it gets
      // the product's canvas rather than an unstyled flash on the way in.
      <div className="flex h-screen w-full flex-col items-center justify-center gap-5 bg-background">
        <PresenceOrb
          hue="var(--cue)"
          className="size-12 animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/signin" replace />;
  }

  return <Outlet />;
}
