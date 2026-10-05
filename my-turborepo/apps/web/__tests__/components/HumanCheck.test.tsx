import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const {
  HUMAN_CHECK_ACTION,
  HumanCheckField,
  humanCheckToken,
  useHumanCheck,
  widgetSize,
} = await import("@/components/HumanCheck");
const { MESSAGES } = await import("@/lib/messages");
const { errorMessage, isHumanCheckRefusal } = await import("@/lib/errors");

// Turnstile's browser API, stubbed at the boundary: `render` records the
// options it was given, so a test can play Cloudflare by calling the callbacks.
type Options = Record<string, unknown> & {
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

let rendered: Options | undefined;
let resets = 0;

beforeEach(() => {
  rendered = undefined;
  resets = 0;
  window.turnstile = {
    render: (_container, options) => {
      rendered = options as Options;
      return "widget-1";
    },
    reset: () => {
      resets += 1;
    },
    remove: () => {},
  };
});

afterEach(() => {
  cleanup();
  delete window.turnstile;
});

let latest: ReturnType<typeof useHumanCheck> | undefined;

function Harness({ siteKey }: { siteKey: string }) {
  const check = useHumanCheck(siteKey);
  latest = check;
  return <HumanCheckField check={check} />;
}

async function mounted(siteKey = "site-key"): Promise<Options> {
  render(<Harness siteKey={siteKey} />);
  await waitFor(() => expect(rendered).toBeDefined());
  return rendered as Options;
}

describe("the human check", () => {
  // Always visible, with Cloudflare's mark.
  it("renders Cloudflare's visible widget for the signup action", async () => {
    const options = await mounted();

    expect(options.sitekey).toBe("site-key");
    expect(options.action).toBe(HUMAN_CHECK_ACTION);
    expect(options.appearance).toBe("always");
  });

  // `flexible` has a 300px floor, wider than the card leaves on a 375px phone.
  it("spans the card where it fits, and goes compact where it would overflow", () => {
    expect(widgetSize(400)).toBe("flexible");
    expect(widgetSize(300)).toBe("flexible");
    expect(widgetSize(277)).toBe("compact");
  });

  it("holds the form until a token arrives, then releases it with that token", async () => {
    const options = await mounted();
    expect(humanCheckToken(latest!.state)).toEqual({ canSubmit: false, token: undefined });

    act(() => options.callback("tok-1"));

    expect(humanCheckToken(latest!.state)).toEqual({ canSubmit: true, token: "tok-1" });
  });

  // Tokens last 300 seconds; a form left open past that must not submit a dead one.
  it("holds the form again when the token expires", async () => {
    const options = await mounted();
    act(() => options.callback("tok-1"));
    act(() => options["expired-callback"]());

    expect(humanCheckToken(latest!.state).canSubmit).toBe(false);
  });

  // The visible widget shows its own progress; only a load failure, which
  // leaves no widget at all, gets words from the page.
  it("adds no text of its own while the widget is working", async () => {
    const options = await mounted();
    act(() => options["expired-callback"]());

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says plainly when the check could not load", async () => {
    const options = await mounted();
    act(() => options["error-callback"]());

    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.HUMAN_CHECK_FAILED);
    expect(humanCheckToken(latest!.state).canSubmit).toBe(false);
  });

  // The token is spent on the first verify, even when the sign-up fails later.
  it("asks Cloudflare for a fresh token on reset, and holds the form meanwhile", async () => {
    const options = await mounted();
    act(() => options.callback("tok-1"));

    act(() => latest!.reset());

    expect(resets).toBe(1);
    expect(humanCheckToken(latest!.state).canSubmit).toBe(false);
  });

  // `bun --hot` without a key in .env: no widget, and the form is not blocked.
  it("stays out of the way when the build has no site key", () => {
    render(<Harness siteKey="" />);

    expect(rendered).toBeUndefined();
    expect(humanCheckToken(latest!.state)).toEqual({ canSubmit: true, token: undefined });
  });
});

describe("a refused sign-up's message", () => {
  function lambdaRefusal(message: string): Error {
    const error = new Error(`PreSignUp failed with error ${message}`);
    error.name = "UserLambdaValidationException";
    return error;
  }

  // The trigger refuses for two reasons under one exception name. A failed human
  // check must not send someone off to find another email address.
  it("tells a failed human check apart from a refused address", () => {
    const humanCheck = lambdaRefusal("We could not confirm you are a person. Please try again.");
    const address = lambdaRefusal("Disposable email addresses cannot be used to sign up.");

    expect(isHumanCheckRefusal(humanCheck)).toBe(true);
    expect(errorMessage(humanCheck, "fallback")).toBe(MESSAGES.AUTH_HUMAN_CHECK_FAILED);
    expect(isHumanCheckRefusal(address)).toBe(false);
    expect(errorMessage(address, "fallback")).toBe(MESSAGES.AUTH_EMAIL_NOT_ALLOWED);
  });
});
