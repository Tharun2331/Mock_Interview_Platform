import { useEffect } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { PresenceOrb } from "@/components/PresenceOrb";
import { completeGoogleSignIn } from "@/lib/authApi";
import { MESSAGES } from "@/lib/messages";

// Where a Google sign-in lands (ADR-0011). By the time the browser is here the
// server has already exchanged Google's code and set the session cookies — the
// code never reached this page. All that is left is to confirm the session
// exists, tell AuthProvider, and go into the app.
//
// A failed or refused Google sign-in does not land here; the server sends it
// to /signin?error=google instead. Reaching this page without a session (a
// bookmark, a stale tab) is treated the same way.
export function Callback() {
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    completeGoogleSignIn()
      .then(() => {
        if (active) navigate("/form", { replace: true });
      })
      .catch(() => {
        if (!active) return;
        toast.error(MESSAGES.AUTH_GOOGLE_FAILED);
        navigate("/signin", { replace: true });
      });

    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-background p-4">
      {/* The same bloom the rest of the product uses, here as the only thing on
          screen. A redirect landing is a moment of doubt about whether anything
          is happening, so it gets the brand mark rather than bare text. */}
      <PresenceOrb
        hue="var(--cue)"
        className="size-16 animate-pulse motion-reduce:animate-none"
      />
      <p className="text-sm text-ink-muted">{MESSAGES.CALLBACK_SIGNING_IN}</p>
    </div>
  );
}
