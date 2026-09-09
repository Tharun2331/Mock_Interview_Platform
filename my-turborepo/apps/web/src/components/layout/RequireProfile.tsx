import { Navigate, Outlet, useLocation } from "react-router";
import { RefreshCwIcon } from "lucide-react";
import { PresenceOrb } from "@/components/PresenceOrb";
import { Button } from "@/components/ui/button";
import { useProfile } from "@/lib/profile";
import { MESSAGES } from "@/lib/messages";

// Sends a candidate who has not finished onboarding to the profile page, and
// nobody else.
//
// The condition is `complete`, computed server-side by isProfileComplete and
// shipped on the profile view. Deriving it here as well would put two
// implementations of "ready to interview" in the codebase, and the first time
// they disagreed the app would either bounce a finished user back into
// onboarding or let an unfinished one reach a session start that 409s.
//
// Nested inside RequireAuth rather than beside it: there is no profile to fetch
// until we know who is asking.
export function RequireProfile() {
  const profile = useProfile();
  const location = useLocation();

  if (profile.status === "loading") {
    return (
      <div className="flex min-h-full w-full flex-col items-center justify-center gap-5 py-20">
        <PresenceOrb
          hue="var(--cue)"
          className="size-12 animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  // A failed fetch must never be read as "no profile yet". Silently redirecting
  // here would walk a returning candidate back through onboarding they have
  // already done, and the resume re-upload would bump their profileVersion and
  // throw away a perfectly good cached plan.
  if (profile.status === "error") {
    return (
      <div className="flex min-h-full w-full flex-col items-center justify-center gap-4 px-4 py-20 text-center">
        <p className="font-display text-xl">{MESSAGES.PROFILE_LOAD_TITLE}</p>
        <p className="max-w-sm text-sm text-ink-subtle">{profile.message}</p>
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={profile.reload}
        >
          <RefreshCwIcon aria-hidden className="size-4" />
          {MESSAGES.RETRY}
        </Button>
      </div>
    );
  }

  if (profile.profile === null || !profile.profile.complete) {
    // `replace` so the incomplete destination does not sit in history behind
    // the profile page — a back press after finishing onboarding should not
    // return to the screen that bounced them.
    //
    // The attempted path is carried so the profile page can send them onward to
    // where they were actually going once they finish.
    return <Navigate to="/profile" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
