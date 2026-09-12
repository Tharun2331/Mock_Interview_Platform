import { signOut } from "aws-amplify/auth";
import { NavLink, useNavigate } from "react-router";
import { toast } from "sonner";
import { LogOutIcon, TrendingUpIcon, UserRoundIcon } from "lucide-react";
import { cn } from "@/lib/utils";

import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useProfile } from "@/lib/profile";
import { MESSAGES } from "@/lib/messages";

// App chrome, and deliberately quiet. Everything below this bar is a system
// state a candidate is reading under time pressure, so the header's job is to
// stay out of the way and hold its hairline.
export function Header() {
  const navigate = useNavigate();
  const profile = useProfile();

  // Keyed on the server's own `complete` boolean — the same flag RequireProfile
  // gates on — so the link and the guard can never disagree about who is
  // allowed through. Deriving "ready to interview" a second way here is how the
  // two drift and someone gets a nav item that bounces them.
  const showHistory =
    profile.status === "ready" && profile.profile?.complete === true;

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate("/signup", { replace: true });
    } catch (error) {
      toast.error(errorMessage(error, MESSAGES.SIGN_OUT_FAILED));
    }
  };

  return (
    <header className="flex h-14 w-full shrink-0 items-center justify-between border-b border-hairline bg-background/80 px-4 backdrop-blur-sm sm:px-6">
      <BrandMark />
      <div className="flex items-center gap-1">
        {/* A content destination, so it leads the group — the theme toggle and
            the two account actions stay together after it.

            Rendered only for a complete profile, because /history sits inside
            RequireProfile: shown earlier it would be a link that bounces
            straight back to onboarding, which reads as the app refusing rather
            than as a guard doing its job. */}
        <ThemeToggle />
        {showHistory ? (
          <NavLink
            to="/history"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                isActive ? "text-ink" : "text-ink-subtle hover:text-ink"
              )
            }
          >
            <TrendingUpIcon aria-hidden className="size-4" />
            {/* Label hidden on the narrowest screens. A fourth item with its
                text visible overflows the bar at 375px, and practising on a
                phone is a real use case. The icon keeps a hit target and the
                accessible name comes from the span, which is present either
                way. */}
            <span className="sr-only sm:not-sr-only">{MESSAGES.HISTORY_NAV}</span>
          </NavLink>
        ) : null}

        

        {/* The profile is no longer part of starting an interview, so this is
            the only way back to it once onboarding is done. NavLink rather
            than Link so the current page is marked, not just linked.

            Sits between the theme toggle and sign-out: the two account actions
            stay adjacent, and the destructive one stays last. */}
        <NavLink
          to="/profile"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              isActive
                ? "text-ink"
                : "text-ink-subtle hover:text-ink"
            )
          }
        >
          <UserRoundIcon aria-hidden className="size-4" />
          {MESSAGES.PROFILE_NAV}
        </NavLink>
        <Button
          variant="ghost"
          size="sm"
          className="cursor-pointer text-ink-subtle hover:text-ink"
          onClick={handleSignOut}
        >
          <LogOutIcon aria-hidden className="size-4" />
          {MESSAGES.SIGN_OUT}
        </Button>
      </div>
    </header>
  );
}
