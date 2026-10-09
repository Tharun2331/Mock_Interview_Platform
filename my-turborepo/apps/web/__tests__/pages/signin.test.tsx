import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
// The SHARED stub. `@/lib/authApi` is one module and a second mock.module
// registration replaces this one for every file loaded afterwards.
import {
  confirmTotpSignIn,
  resetAuthApiStub,
  signIn,
  startGoogleSignIn,
} from "../helpers/authApiStub";

const { SignIn } = await import("@/pages/signin");
const { AppToaster } = await import("@/components/AppToaster");
const { MESSAGES } = await import("@/lib/messages");
const { AuthApiError } = await import("@/lib/errors");
const { MemoryRouter, Route, Routes } = await import("react-router");

function renderPage(
  entry: string | { pathname: string; state: unknown } = "/signin",
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/form" element={<p>pre-interview form</p>} />
        <Route path="/confirm" element={<p>confirm page</p>} />
      </Routes>
      {/* The real toaster, matching startInterview.test.tsx's convention. */}
      <AppToaster />
    </MemoryRouter>,
  );
}

function toastShown(text: string): boolean {
  return Array.from(document.querySelectorAll("[data-sonner-toast]")).some(
    (node) => (node.textContent ?? "").includes(text),
  );
}

function fillCredentials(): void {
  fireEvent.change(screen.getByLabelText(MESSAGES.FIELD_EMAIL_LABEL), {
    target: { value: "tharun@example.com" },
  });
  fireEvent.change(screen.getByLabelText(MESSAGES.FIELD_PASSWORD_LABEL), {
    target: { value: "hunter2Aa!" },
  });
  fireEvent.click(screen.getByRole("button", { name: MESSAGES.SIGNIN_SUBMIT }));
}

async function submitCredentials(): Promise<void> {
  fillCredentials();
  await screen.findByText(MESSAGES.SIGNIN_TOTP_TITLE);
}

function enterCode(code: string): void {
  fireEvent.change(screen.getByLabelText(MESSAGES.SIGNIN_TOTP_CODE_LABEL), {
    target: { value: code },
  });
  fireEvent.click(
    screen.getByRole("button", { name: MESSAGES.SIGNIN_TOTP_SUBMIT }),
  );
}

beforeEach(() => {
  resetAuthApiStub();
});

afterEach(cleanup);

describe("password sign-in", () => {
  it("goes into the app when the server says DONE", async () => {
    renderPage();

    fillCredentials();

    expect(await screen.findByText("pre-interview form")).toBeDefined();
    expect(signIn).toHaveBeenCalledWith("tharun@example.com", "hunter2Aa!");
  });

  it("sends an unverified account to confirmation", async () => {
    signIn.mockImplementationOnce(async () => "CONFIRM_SIGN_UP");
    renderPage();

    fillCredentials();

    expect(await screen.findByText("confirm page")).toBeDefined();
  });

  // The server collapses unknown-email and wrong-password into one code; the
  // page has exactly one message for it.
  it("shows the shared invalid-credentials message", async () => {
    signIn.mockImplementationOnce(async () => {
      throw new AuthApiError("INVALID_CREDENTIALS");
    });
    renderPage();

    fillCredentials();

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_INVALID_CREDENTIALS)).toBe(true),
    );
  });

  // Arriving from a just-confirmed account: only the password is left to type.
  it("prefills the email handed over by the confirm page", () => {
    renderPage({ pathname: "/signin", state: { email: "new@example.com" } });

    expect(
      (screen.getByLabelText(MESSAGES.FIELD_EMAIL_LABEL) as HTMLInputElement)
        .value,
    ).toBe("new@example.com");
  });
});

describe("Google", () => {
  it("hands off to the server's Google route", () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.CONTINUE_WITH_GOOGLE }),
    );

    expect(startGoogleSignIn).toHaveBeenCalledTimes(1);
  });

  // Where the server sends a failed or refused Google sign-in.
  it("explains a failed Google sign-in it was sent back from", async () => {
    renderPage("/signin?error=google");

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_GOOGLE_FAILED)).toBe(true),
    );
  });
});

// Only an account that turned MFA on in Settings reaches this step — the pool
// is OPTIONAL, so a plain account never sees it.
describe("the two-factor challenge", () => {
  it("is skipped entirely when the account has no MFA enrolled", async () => {
    renderPage();

    fillCredentials();

    expect(await screen.findByText("pre-interview form")).toBeDefined();
    expect(screen.queryByText(MESSAGES.SIGNIN_TOTP_TITLE)).toBeNull();
  });

  it("appears after a correct password for an enrolled account", async () => {
    signIn.mockImplementationOnce(async () => "TOTP");
    renderPage();

    await submitCredentials();

    // The password field is gone — the server already accepted it, and asking
    // again would suggest it was rejected.
    expect(screen.queryByLabelText(MESSAGES.FIELD_PASSWORD_LABEL)).toBeNull();
  });

  it("signs in on a correct code, sending only the code", async () => {
    signIn.mockImplementationOnce(async () => "TOTP");
    renderPage();
    await submitCredentials();

    enterCode("123456");

    // The pending sign-in lives in a server cookie; no credentials travel again.
    await waitFor(() => {
      expect(confirmTotpSignIn).toHaveBeenCalledWith("123456");
    });
    expect(await screen.findByText("pre-interview form")).toBeDefined();
  });

  it("reports a wrong code and stays on the challenge, not the password form", async () => {
    signIn.mockImplementationOnce(async () => "TOTP");
    confirmTotpSignIn.mockImplementationOnce(async () => {
      throw new AuthApiError("CODE_INVALID");
    });
    renderPage();
    await submitCredentials();

    enterCode("000000");

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_CODE_INVALID)).toBe(true),
    );
    expect(screen.getByText(MESSAGES.SIGNIN_TOTP_TITLE)).toBeDefined();
  });

  // The pending sign-in lasts three minutes; past that a code cannot help.
  it("returns to the password form when the pending sign-in has expired", async () => {
    signIn.mockImplementationOnce(async () => "TOTP");
    confirmTotpSignIn.mockImplementationOnce(async () => {
      throw new AuthApiError("SIGNIN_EXPIRED");
    });
    renderPage();
    await submitCredentials();

    enterCode("123456");

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_SIGNIN_EXPIRED)).toBe(true),
    );
    expect(screen.getByLabelText(MESSAGES.FIELD_PASSWORD_LABEL)).toBeDefined();
  });

  it("returns to the password form on request", async () => {
    signIn.mockImplementationOnce(async () => "TOTP");
    renderPage();
    await submitCredentials();

    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.SIGNIN_TOTP_BACK }),
    );

    expect(screen.getByLabelText(MESSAGES.FIELD_EMAIL_LABEL)).toBeDefined();
  });
});
