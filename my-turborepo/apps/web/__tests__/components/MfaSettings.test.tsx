import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
// The SHARED stub. `aws-amplify/auth` is one module and a second
// mock.module registration replaces this one for every file loaded afterwards.
import {
  fetchMFAPreference,
  resetAmplifyAuthStub,
  updateMFAPreference,
  verifyTOTPSetup,
} from "../helpers/amplifyAuthStub";

const { MfaSettings } = await import("@/components/MfaSettings");
const { AppToaster } = await import("@/components/AppToaster");
const { MESSAGES } = await import("@/lib/messages");

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
  resetAmplifyAuthStub();
});

afterEach(cleanup);

describe("loading", () => {
  it("shows the off state once the preference is read", async () => {
    fetchMFAPreference.mockImplementationOnce(async () => ({
      enabled: [],
      preferred: undefined,
    }));
    renderSettings();

    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
    expect(
      screen.getByRole("button", { name: MESSAGES.MFA_ENABLE }),
    ).toBeDefined();
  });

  it("shows the on state when TOTP is already preferred", async () => {
    fetchMFAPreference.mockImplementationOnce(async () => ({
      enabled: ["TOTP"],
      preferred: "TOTP",
    }));
    renderSettings();

    expect(await screen.findByText(MESSAGES.MFA_ON_TITLE)).toBeDefined();
  });

  it("offers a retry when the preference read fails", async () => {
    fetchMFAPreference.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    renderSettings();

    const retry = await screen.findByRole("button", {
      name: MESSAGES.RETRY,
    });
    // Recovers on the next attempt rather than staying stuck.
    fetchMFAPreference.mockImplementationOnce(async () => ({
      enabled: [],
      preferred: undefined,
    }));
    fireEvent.click(retry);

    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
  });
});

describe("enrolling", () => {
  beforeEach(() => {
    fetchMFAPreference.mockImplementation(async () => ({
      enabled: [],
      preferred: undefined,
    }));
  });

  it("starts a setup and shows the manual key", async () => {
    renderSettings();

    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );

    expect(await screen.findByText(MESSAGES.MFA_SETUP_TITLE)).toBeDefined();
    // Chunked in groups of 4 — see chunkSecret in the component.
    expect(screen.getByText("TEST SECR ET23 4567")).toBeDefined();
  });

  it("turns MFA on after a correct code, and asks nothing more of it", async () => {
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );
    await screen.findByText(MESSAGES.MFA_SETUP_TITLE);

    fireEvent.change(
      screen.getByLabelText(MESSAGES.MFA_SETUP_CODE_LABEL),
      { target: { value: "123456" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.MFA_SETUP_VERIFY }),
    );

    await waitFor(() => {
      expect(verifyTOTPSetup).toHaveBeenCalledWith({ code: "123456" });
    });
    // Enrolling a device alone leaves the account still checking only a
    // password — this call is what actually switches it on.
    expect(updateMFAPreference).toHaveBeenCalledWith({ totp: "PREFERRED" });
    expect(await screen.findByText(MESSAGES.MFA_ON_TITLE)).toBeDefined();
    expect(toastShown(MESSAGES.MFA_ENABLED)).toBe(true);
  });

  it("reports a wrong code without leaving the setup screen", async () => {
    verifyTOTPSetup.mockImplementationOnce(async () => {
      const error = new Error("code mismatch");
      error.name = "EnableSoftwareTokenMFAException";
      throw error;
    });
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_ENABLE }),
    );
    await screen.findByText(MESSAGES.MFA_SETUP_TITLE);

    fireEvent.change(
      screen.getByLabelText(MESSAGES.MFA_SETUP_CODE_LABEL),
      { target: { value: "000000" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.MFA_SETUP_VERIFY }),
    );

    await waitFor(() =>
      expect(toastShown(MESSAGES.AUTH_CODE_INVALID)).toBe(true),
    );
    expect(updateMFAPreference).not.toHaveBeenCalled();
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
    expect(verifyTOTPSetup).not.toHaveBeenCalled();
  });
});

describe("disabling", () => {
  beforeEach(() => {
    fetchMFAPreference.mockImplementation(async () => ({
      enabled: ["TOTP"],
      preferred: "TOTP",
    }));
  });

  it("stays on until the confirmation is accepted", async () => {
    renderSettings();
    fireEvent.click(
      await screen.findByRole("button", { name: MESSAGES.MFA_DISABLE }),
    );

    expect(
      await screen.findByText(MESSAGES.MFA_DISABLE_TITLE),
    ).toBeDefined();
    expect(updateMFAPreference).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(MESSAGES.MFA_DISABLE_CANCEL));
    expect(updateMFAPreference).not.toHaveBeenCalled();
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
    fireEvent.click(
      within(dialog).getByText(MESSAGES.MFA_DISABLE_CONFIRM),
    );

    await waitFor(() => {
      expect(updateMFAPreference).toHaveBeenCalledWith({ totp: "DISABLED" });
    });
    expect(await screen.findByText(MESSAGES.MFA_OFF_TITLE)).toBeDefined();
    expect(toastShown(MESSAGES.MFA_DISABLED)).toBe(true);
  });
});
