import { useEffect } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Hub } from "aws-amplify/utils";
import { getCurrentUser } from "aws-amplify/auth";
import { errorMessage } from "@/lib/errors";
import { MESSAGES } from "@/lib/messages";

// Landing route for the Cognito hosted-UI redirect (matches the client's
// `callback_urls`). Amplify parses the `?code=` and exchanges it for tokens on
// load, emitting Hub `auth` events when it finishes. We wait for those and then
// route the user into the app.
export function Callback() {
  const navigate = useNavigate();

  useEffect(() => {
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      switch (payload.event) {
        case "signInWithRedirect":
          navigate("/form", { replace: true });
          break;
        case "signInWithRedirect_failure":
          toast.error(MESSAGES.AUTH_GOOGLE_FAILED);
          navigate("/signup", { replace: true });
          break;
      }
    });

    // The exchange may have already completed before this listener attached
    // (e.g. fast reload), so check for an existing session as a fallback.
    getCurrentUser()
      .then(() => navigate("/form", { replace: true }))
      .catch((error) => {
        // No session yet — the Hub listener above will drive navigation once
        // the redirect exchange resolves. A hard failure is surfaced there.
        void errorMessage(error, "");
      });

    return unsubscribe;
  }, [navigate]);

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-4">
      <p className="text-muted-foreground text-sm">
        {MESSAGES.CALLBACK_SIGNING_IN}
      </p>
    </div>
  );
}
