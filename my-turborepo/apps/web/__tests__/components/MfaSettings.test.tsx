import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
// The SHARED stub. `@/lib/authApi` is one module and a second mock.module
// registration replaces this one for every file loaded afterwards.
import {
  disableTotp,
  fetchTotpEnabled,
  resetAuthApiStub,
  startTotpSetup,
  verifyTotpSetup,
} from "../helpers/authApiStub";

const { MfaSettings } = await import("@/components/MfaSettings");
const { AppToaster } = await import("@/components/AppToaster");
const { MESSAGES } = await import("@/lib/messages");
const { AuthApiError } = await import("@/lib/errors");

function renderSettings() {
  return render(
    <>
      <MfaSettings />
      {/* The real toaster, so a toast is observable as text on screen —
          matching the convention in __tests__/pages/startInterview.test.tsx. */}
      <AppToaster />
    </>,
  );
}

function toastShown(text: string): boolean {
  return Array.from(document.querySelectorAll("[data-sonner-toast]")).some(
    (node) => (node.textContent ?? "").includes(text),
  );
}

beforeEach(() => {
  resetAuthApiStub();
});

afterEach(cleanup);

describe("loading", () => {
  it("shows the off state once the status is read", async () => {
    fetchTotpEnabled.mockImplementationOnce(async () => false);
    renderSettings();

    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
    expect(
      screen.getByRole("button", { name: MESSAGES.MFA_ENABLE }),
    ).toBeDefined();
  });

  it("shows the on state when TOTP is already on", async () => {
    fetchTotpEnabled.mockImplementationOnce(async () => true);
    renderSettings();

    expect(await screen.findByText(MESSAGES.MFA_ON_TITLE)).toBeDefined();
  });

  it("offers a retry when the status read fails", async () => {
    fetchTotpEnabled.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    renderSettings();

    const retry = await screen.findByRole("button", {
      name: MESSAGES.RETRY,
    });
    // Recovers on the next attempt rather than staying stuck.
    fetchTotpEnabled.mockImplementationOnce(async () => false);
    fireEvent.click(retry);

    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
  });

  // A settings screen never asked for a password, so an ended session must
  // say so — not "incorrect email or password".
  it("says the session ended rather than blaming a password", async () => {
    fetchTotpEnabled.mockImplementationOnce(async () => {
      throw new AuthApiError("UNAUTHENTICATED");
    });
    renderSettings();

    expect(
      await screen.findByText(MESSAGES.AUTH_SESSION_EXPIRED),
    ).toBeDefined();
  });
});

describe("enrolling", () => {
  beforeEach(() => {
    fetchTotpEnabled.mockImplementation(async () => false);
  });

  it("starts a setup and shows the manual key", async () => {
    renderSettings();

    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );

    expect(await screen.findByText(MESSAGES.MFA_SETUP_TITLE)).toBeDefined();
    expect(startTotpSetup).toHaveBeenCalledTimes(1);
    // Chunked in groups of 4 — see chunkSecret in the component.
    expect(screen.getByText("TEST SECR ET23 4567")).toBeDefined();
  });

  // The server verifies the device and makes TOTP preferred in one call, so a
  // correct code is the whole of turning it on.
  it("turns MFA on after a correct code", async () => {
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );
    await screen.findByText(MESSAGES.MFA_SETUP_TITLE);

    fireEvent.change(screen.getByLabelText(MESSAGES.MFA_SETUP_CODE_LABEL), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.MFA_SETUP_VERIFY }),
    );

    await waitFor(() => {
      expect(verifyTotpSetup).toHaveBeenCalledWith("123456");
    });
    expect(await screen.findByText(MESSAGES.MFA_ON_TITLE)).toBeDefined();
    expect(toastShown(MESSAGES.MFA_ENABLED)).toBe(true);
  });

  it("reports a wrong code without leaving the setup screen", async () => {
    verifyTotpSetup.mockImplementationOnce(async () => {
      throw new AuthApiError("CODE_INVALID");
    });
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );
    await screen.findByText(MESSAGES.MFA_SETUP_TITLE);

    fireEvent.change(screen.getByLabelText(MESSAGES.MFA_SETUP_CODE_LABEL), {
      target: { value: "000000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.MFA_SETUP_VERIFY }),
    );

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_CODE_INVALID)).toBe(true),
    );
    // Still on the setup screen — a wrong code costs one retry, not the
    // whole flow.
    expect(screen.getByText(MESSAGES.MFA_SETUP_TITLE)).toBeDefined();
  });

  it("cancels back to off without calling anything further", async () => {
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );
    await screen.findByText(MESSAGES.MFA_SETUP_TITLE);

    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.MFA_SETUP_CANCEL }),
    );

    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
    expect(verifyTotpSetup).not.toHaveBeenCalled();
  });
});

describe("disabling", () => {
  beforeEach(() => {
    fetchTotpEnabled.mockImplementation(async () => true);
  });

  it("stays on until the confirmation is accepted", async () => {
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_DISABLE }),
    );

    expect(await screen.findByText(MESSAGES.MFA_DISABLE_TITLE)).toBeDefined();
    expect(disableTotp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(MESSAGES.MFA_DISABLE_CANCEL));
    expect(disableTotp).not.toHaveBeenCalled();
    expect(screen.getByText(MESSAGES.MFA_ON_TITLE)).toBeDefined();
  });

  it("turns MFA off on confirmation", async () => {
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_DISABLE }),
    );
    await screen.findByText(MESSAGES.MFA_DISABLE_TITLE);

    // Scoped to the dialog: its trigger button carries the same "Turn off"
    // label as its own confirm button, so an unscoped query would be
    // ambiguous between the two.
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByText(MESSAGES.MFA_DISABLE_CONFIRM));

    await waitFor(() => {
      expect(disableTotp).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
    expect(toastShown(MESSAGES.MFA_DISABLED)).toBe(true);
  });
});
