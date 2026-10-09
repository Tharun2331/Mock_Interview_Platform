import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
// The SHARED stub — `@/lib/authApi` is one module, and a second mock.module
// registration replaces this one for every file loaded afterwards.
import { confirmSignUp, resetAuthApiStub } from "../helpers/authApiStub";

const { Confirm } = await import("@/pages/confirm");
const { MESSAGES } = await import("@/lib/messages");
const { AuthApiError } = await import("@/lib/errors");
const { MemoryRouter, Route, Routes, useLocation } =
  await import("react-router");

// Shows what the sign-in page was handed, so the test can see the email
// travel without the password.
function SignInProbe() {
  const { state } = useLocation();
  return <p>sign-in page {JSON.stringify(state)}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: "/confirm", state: { email: "tharun@example.com" } },
      ]}
    >
      <Routes>
        <Route path="/confirm" element={<Confirm />} />
        <Route path="/signin" element={<SignInProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function submitCode(code: string): void {
  fireEvent.change(screen.getByLabelText(MESSAGES.CONFIRM_CODE_LABEL), {
    target: { value: code },
  });
  fireEvent.click(
    screen.getByRole("button", { name: MESSAGES.CONFIRM_SUBMIT }),
  );
}

beforeEach(() => {
  resetAuthApiStub();
});

afterEach(cleanup);

// Cognito's default sender is filed as spam by most mail providers, so the code
// is usually not in the inbox. The hint has to be on screen before someone gives
// up waiting, not behind an error.
describe("the confirmation code screen", () => {
  it("tells the candidate to check their spam folder", () => {
    renderPage();

    expect(screen.getByText(MESSAGES.CONFIRM_SPAM_HINT)).toBeDefined();
    expect(MESSAGES.CONFIRM_SPAM_HINT.toLowerCase()).toContain("spam");
  });

  // Shown beside the code field, where the person is looking for the code. The
  // address-correction form has no code to look for.
  it("does not show it while correcting the email address", () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: MESSAGES.CONFIRM_EDIT_EMAIL }),
    );

    expect(screen.queryByText(MESSAGES.CONFIRM_SPAM_HINT)).toBeNull();
  });
});

// Confirming no longer signs in (ADR-0011): that would mean the server holding
// the password between two requests. It lands on sign-in instead.
describe("confirming", () => {
  it("moves on to sign-in, handing over the email and nothing else", async () => {
    renderPage();

    submitCode("123456");

    expect(
      await screen.findByText('sign-in page {"email":"tharun@example.com"}'),
    ).toBeDefined();
    expect(confirmSignUp).toHaveBeenCalledWith("tharun@example.com", "123456");
  });

  it("stays put on a wrong code", async () => {
    confirmSignUp.mockImplementationOnce(async () => {
      throw new AuthApiError("CODE_INVALID");
    });
    renderPage();

    submitCode("000000");

    await waitFor(() => expect(confirmSignUp).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/sign-in page/)).toBeNull();
    expect(screen.getByLabelText(MESSAGES.CONFIRM_CODE_LABEL)).toBeDefined();
  });
});
