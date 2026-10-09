import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTheme } from "next-themes";
import { TURNSTILE_SITE_KEY } from "@/lib/config";
import { MESSAGES } from "@/lib/messages";

// The sign-up form's human check: Cloudflare Turnstile.
//
// Without this, anything able to call the sign-up route (or Cognito's SignUp
// API directly) could farm accounts — and every account gets free interviews,
// each a billed voice stream. The widget yields a single-use token; the form
// sends it to the API, which passes it on as validationData, and the pre
// sign-up trigger verifies it with Cloudflare
// (infra/terraform/modules/cognito/pre_sign_up).
//
// `always`: the widget, with Cloudflare's mark, is visible from page load, so
// the form visibly says it is protected. (It was `interaction-only` at first,
// which hid it unless Cloudflare wanted a person to look; the protection is the
// server-side verification either way.) Visible, it shows its own states —
// verifying, done, refreshing — so this file only adds words for the one case
// it cannot show: failing to load at all.

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Must match TURNSTILE_ACTION in the trigger, which refuses a token solved for
// any other action.
export const HUMAN_CHECK_ACTION = "signup";

type TurnstileApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

// Rendered from this, never from loose booleans.
export type HumanCheckState =
  // No site key in this build — `bun --hot` without one in .env. The form
  // submits without a token, which the trigger only accepts in monitor mode.
  | { status: "unconfigured" }
  | { status: "loading" }
  | { status: "ready"; token: string }
  // Tokens live 300 seconds. Turnstile refreshes an expired one by itself
  // ("refresh-expired: auto"); this is the moment in between.
  | { status: "expired" }
  // The script was blocked or the challenge errored. Turnstile retries on its
  // own, so a later success still lands in `ready`.
  | { status: "failed" };

// `flexible` spans the card like the inputs above it, but has a 300px floor.
// On a 375px phone the page and card padding leave ~277px, where it would
// overflow the card, so narrow screens get `compact` (150 x 140) instead.
// Measured once at render, which is when Turnstile fixes the size.
const FLEXIBLE_MIN_WIDTH = 300;

export function widgetSize(availableWidth: number): "flexible" | "compact" {
  return availableWidth >= FLEXIBLE_MIN_WIDTH ? "flexible" : "compact";
}

let scriptPromise: Promise<TurnstileApi> | undefined;

// One script per page, however many times the form mounts. A failed load is
// forgotten so the next mount tries again.
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile !== undefined) return Promise.resolve(window.turnstile);

  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile !== undefined
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile loaded without its API"));
    script.onerror = () => {
      scriptPromise = undefined;
      script.remove();
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export type HumanCheck = {
  containerRef: RefObject<HTMLDivElement | null>;
  state: HumanCheckState;
  // The token is single-use: Cloudflare consumes it on the first verify, even
  // when the sign-up then fails for another reason. Call after every failed
  // submit so the next attempt has a fresh one.
  reset: () => void;
};

// State and the handler that changes it live together, so the form never
// needs an adapter between them.
export function useHumanCheck(
  siteKey: string = TURNSTILE_SITE_KEY,
): HumanCheck {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<HumanCheckState>(
    siteKey.length > 0 ? { status: "loading" } : { status: "unconfigured" },
  );

  useEffect(() => {
    if (siteKey.length === 0) return;
    let cancelled = false;

    loadTurnstile()
      .then((api) => {
        if (cancelled || containerRef.current === null) return;
        widgetId.current = api.render(containerRef.current, {
          sitekey: siteKey,
          action: HUMAN_CHECK_ACTION,
          appearance: "always",
          size: widgetSize(containerRef.current.clientWidth),
          // Read once at render. A theme switch mid-form is not worth tearing
          // down a challenge the person may be halfway through.
          theme: resolvedTheme === "light" ? "light" : "dark",
          "refresh-expired": "auto",
          callback: (token: string) => setState({ status: "ready", token }),
          "expired-callback": () => setState({ status: "expired" }),
          "error-callback": () => setState({ status: "failed" }),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });

    return () => {
      cancelled = true;
      if (widgetId.current !== undefined) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = undefined;
      }
    };
    // resolvedTheme deliberately omitted — see the note on `theme` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  const reset = useCallback(() => {
    if (widgetId.current === undefined) return;
    setState({ status: "loading" });
    window.turnstile?.reset(widgetId.current);
  }, []);

  return { containerRef, state, reset };
}

/** The widget's mount point, and words for the one state it cannot show itself. */
export function HumanCheckField({ check }: { check: HumanCheck }) {
  const { state } = check;

  return (
    <div className="flex w-full flex-col items-center gap-2">
      {/* Cloudflare's widget renders here and shows its own progress. */}
      <div ref={check.containerRef} className="w-full" />

      {/* A blocked script leaves no widget to say anything, so this does. */}
      {state.status === "failed" && (
        <p role="alert" className="text-center text-xs text-destructive">
          {MESSAGES.HUMAN_CHECK_FAILED}
        </p>
      )}
    </div>
  );
}

/** Whether the form may submit, and with which token. */
export function humanCheckToken(state: HumanCheckState): {
  canSubmit: boolean;
  token: string | undefined;
} {
  if (state.status === "ready") return { canSubmit: true, token: state.token };
  if (state.status === "unconfigured")
    return { canSubmit: true, token: undefined };
  return { canSubmit: false, token: undefined };
}
