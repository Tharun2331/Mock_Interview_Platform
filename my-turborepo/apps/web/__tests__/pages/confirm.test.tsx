import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
// The SHARED stub — `aws-amplify/auth` is one module, and a second
// mock.module registration replaces this one for every file loaded afterwards.
import { resetAmplifyAuthStub } from "../helpers/amplifyAuthStub";

const { Confirm } = await import("@/pages/confirm");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={[
        { pathname: "/confirm", state: { email: "tharun@example.com" } },
      ]}
    >
      <Routes>
        <Route path="/confirm" element={<Confirm />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetAmplifyAuthStub();
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
