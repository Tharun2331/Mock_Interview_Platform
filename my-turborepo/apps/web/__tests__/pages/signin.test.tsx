import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// The SHARED stub. `aws-amplify/auth` is one module and a second
// mock.module registration replaces this one for every file loaded afterwards.
import {
  confirmSignIn,
  resetAmplifyAuthStub,
  signIn,
} from "../helpers/amplifyAuthStub";

const { SignIn } = await import("@/pages/signin");
const { AppToaster } = await import("@/components/AppToaster");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/signin"]}>
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

async function submitCredentials(): Promise<void> {
  fireEvent.change(screen.getByLabelText(MESSAGES.FIELD_EMAIL_LABEL), {
    target: { value: "tharun@example.com" },
  });
  fireEvent.change(screen.getByLabelText(MESSAGES.FIELD_PASSWORD_LABEL), {
    target: { value: "hunter2Aa!" },
  });
  fireEvent.click(screen.getByRole("button", { name: MESSAGES.SIGNIN_SUBMIT }));
  await screen.findByText(MESSAGES.SIGNIN_TOTP_TITLE);
}

beforeEach(() => {
  resetAmplifyAuthStub();
});

afterEach(cleanup);

// Only an account that turned MFA on in Settings reaches this step — the pool
// is OPTIONAL, so a plain account never sees it.
describe("the two-factor challenge", () => {
  it("is skipped entirely when the account has no MFA enrolled", async () => {
    signIn.mockImplementationOnce(async () => ({
      isSignedIn: true,
      nextStep: { signInStep: "DONE" as const },
    }));
    renderPage();

    fireEvent.change(screen.getByLabelText(MESSAGES.FIELD_EMAIL_LABEL), {
      target: { value: "tharun@example.com" },
    });
    fireEvent.change(screen.getByLabelText(MESSAGES.FIELD_PASSWORD_LABEL), {
      target: { value: "hunter2Aa!" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.SIGNIN_SUBMIT }),
    );

    expect(await screen.findByText("pre-interview form")).toBeDefined();
  });

  it("appears after a correct password for an enrolled account", async () => {
    signIn.mockImplementationOnce(async () => ({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" as const },
    }));
    renderPage();

    await submitCredentials();

    // The password field is gone — Amplify already accepted it, and asking
    // again would suggest it was rejected.
    expect(screen.queryByLabelText(MESSAGES.FIELD_PASSWORD_LABEL)).toBeNull();
  });

  it("signs in on a correct code, without re-sending the password", async () => {
    signIn.mockImplementationOnce(async () => ({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" as const },
    }));
    renderPage();
    await submitCredentials();

    fireEvent.change(
      screen.getByLabelText(MESSAGES.SIGNIN_TOTP_CODE_LABEL),
      { target: { value: "123456" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.SIGNIN_TOTP_SUBMIT }),
    );

    await waitFor(() => {
      // challengeResponse only — confirmSignIn continues the pending sign-in
      // Amplify is already tracking; no credentials are sent again.
      expect(confirmSignIn).toHaveBeenCalledWith({
        challengeResponse: "123456",
      });
    });
    expect(await screen.findByText("pre-interview form")).toBeDefined();
  });

  it("reports a wrong code and stays on the challenge, not the password form", async () => {
    signIn.mockImplementationOnce(async () => ({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" as const },
    }));
    confirmSignIn.mockImplementationOnce(async () => {
      const error = new Error("code mismatch");
      error.name = "CodeMismatchException";
      throw error;
    });
    renderPage();
    await submitCredentials();

    fireEvent.change(
      screen.getByLabelText(MESSAGES.SIGNIN_TOTP_CODE_LABEL),
      { target: { value: "000000" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.SIGNIN_TOTP_SUBMIT }),
    );

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_CODE_INVALID)).toBe(true),
    );
    expect(screen.getByText(MESSAGES.SIGNIN_TOTP_TITLE)).toBeDefined();
  });

  it("returns to the password form on request", async () => {
    signIn.mockImplementationOnce(async () => ({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" as const },
    }));
    renderPage();
    await submitCredentials();

    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.SIGNIN_TOTP_BACK }),
    );

    expect(screen.getByLabelText(MESSAGES.FIELD_EMAIL_LABEL)).toBeDefined();
  });
});
