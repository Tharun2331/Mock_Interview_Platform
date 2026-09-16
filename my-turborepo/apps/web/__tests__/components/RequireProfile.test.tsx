import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
// The SHARED profile stub, not a local mock.module. `@/lib/profile` is one
// module and a second registration anywhere replaces this one for every file
// loaded afterwards — see the header of the helper.
import {
  COMPLETE_PROFILE as COMPLETE,
  reload,
  resetProfileStub,
  setProfileState,
} from "../helpers/profileStub";

const { RequireProfile } = await import("@/components/layout/RequireProfile");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter, Route, Routes } = await import("react-router");

// Renders the guard at `from`, with a marker on the protected route and another
// on /profile, so a redirect is observable as a DOM change.
function renderGuard(from = "/start") {
  return render(
    <MemoryRouter initialEntries={[from]}>
      <Routes>
        <Route element={<RequireProfile />}>
          <Route path="/start" element={<p>protected content</p>} />
        </Route>
        <Route path="/profile" element={<p>onboarding page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(resetProfileStub);

afterEach(cleanup);

describe("RequireProfile", () => {
  it("holds the candidate on a loading state rather than guessing", () => {
    setProfileState({ status: "loading" });
    renderGuard();

    expect(screen.getByText(MESSAGES.LOADING)).toBeDefined();
    expect(screen.queryByText("onboarding page")).toBeNull();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("lets a complete profile through to the protected route", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderGuard();

    expect(screen.getByText("protected content")).toBeDefined();
  });

  it("sends a first-time candidate to onboarding", () => {
    setProfileState({ status: "ready", profile: null });
    renderGuard();

    expect(screen.getByText("onboarding page")).toBeDefined();
  });

  it("sends an incomplete profile to onboarding", () => {
    setProfileState({
      status: "ready",
      profile: { ...COMPLETE, complete: false, hasResume: false },
    });
    renderGuard();

    expect(screen.getByText("onboarding page")).toBeDefined();
  });

  // The guard keys on the server's `complete` boolean and nothing else.
  // Re-deriving it here would put two implementations of "ready to interview"
  // in the codebase, and the first disagreement bounces a finished candidate.
  it("trusts the server's `complete` flag over the fields behind it", () => {
    setProfileState({
      status: "ready",
      // Every underlying field says incomplete; the server says complete.
      profile: {
        ...COMPLETE,
        complete: true,
        hasResume: false,
        firstName: undefined,
        lastName: undefined,
      },
    });
    renderGuard();

    expect(screen.getByText("protected content")).toBeDefined();
  });

  describe("a failed fetch", () => {
    // The most important test in this file. Redirecting on error would walk a
    // returning candidate back through onboarding they already finished, and
    // the resume re-upload would bump profileVersion and discard a perfectly
    // good cached plan.
    it("is never mistaken for 'no profile yet'", () => {
      setProfileState({ status: "error", message: "Network unreachable" });
      renderGuard();

      expect(screen.queryByText("onboarding page")).toBeNull();
    });

    it("is its own screen, showing the cause and a retry", () => {
      setProfileState({ status: "error", message: "Network unreachable" });
      renderGuard();

      expect(screen.getByText(MESSAGES.PROFILE_LOAD_TITLE)).toBeDefined();
      expect(screen.getByText("Network unreachable")).toBeDefined();
      expect(screen.getByRole("button", { name: new RegExp(MESSAGES.RETRY, "i") }))
        .toBeDefined();
    });

    it("refetches when retry is pressed", () => {
      setProfileState({ status: "error", message: "Network unreachable" });
      renderGuard();

      screen
        .getByRole("button", { name: new RegExp(MESSAGES.RETRY, "i") })
        .click();

      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("does not let the protected route render", () => {
      setProfileState({ status: "error", message: "Network unreachable" });
      renderGuard();

      expect(screen.queryByText("protected content")).toBeNull();
    });
  });
});
