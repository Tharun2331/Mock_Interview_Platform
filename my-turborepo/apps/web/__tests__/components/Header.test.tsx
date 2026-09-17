import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
// The SHARED stubs, not local mock.module calls. Each of these modules is
// registered exactly once for the whole process — see the helpers' headers.
import "../helpers/amplifyAuthStub";
import {
  COMPLETE_PROFILE as COMPLETE,
  resetProfileStub,
  setProfileState,
  type ProfileState,
} from "../helpers/profileStub";

const { Header } = await import("@/components/layout/Header");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter } = await import("react-router");

function renderHeader(path = "/start") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>
  );
}

beforeEach(resetProfileStub);

afterEach(cleanup);

describe("the history link", () => {
  it("points at the history page for a complete profile", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    const link = screen.getByRole("link", { name: MESSAGES.HISTORY_NAV });
    expect(link.getAttribute("href")).toBe("/history");
  });

  // /history sits inside RequireProfile. Shown earlier it would be a link that
  // bounces straight back to onboarding, which reads as the app refusing rather
  // than as a guard doing its job.
  it("is hidden while the profile is incomplete", () => {
    setProfileState({
      status: "ready",
      profile: { ...COMPLETE, complete: false, hasResume: false },
    });
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV })).toBeNull();
  });

  it("is hidden for a candidate who has saved no profile yet", () => {
    setProfileState({ status: "ready", profile: null });
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV })).toBeNull();
  });

  // Neither state knows whether the candidate may pass, and guessing wrong in
  // the permissive direction is the one that produces a bouncing link.
  it.each([
    ["loading", { status: "loading" } as ProfileState],
    ["errored", { status: "error", message: "network down" } as ProfileState],
  ])("is hidden while the profile is %s", (_label, state) => {
    setProfileState(state);
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV })).toBeNull();
  });

  // The label is visually hidden on the narrowest screens, so the accessible
  // name has to come from text that is always in the DOM rather than from a
  // conditionally rendered span.
  it("keeps an accessible name even where the label is visually hidden", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    expect(
      screen.getByRole("link", { name: MESSAGES.HISTORY_NAV })
    ).toBeDefined();
  });
});

// Gated exactly like history, and for the same reason: both read a
// candidate's own finished interviews, so neither means anything before there
// are any. Shown earlier, they would be links that bounce to onboarding.
describe("the coach link", () => {
  it("points at the coach page for a complete profile", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    const link = screen.getByRole("link", { name: MESSAGES.COACH_NAV });
    expect(link.getAttribute("href")).toBe("/coach");
  });

  it("is hidden for a candidate who has saved no profile yet", () => {
    setProfileState({ status: "ready", profile: null });
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.COACH_NAV })).toBeNull();
  });

  it.each([
    ["loading", { status: "loading" } as ProfileState],
    ["errored", { status: "error", message: "network down" } as ProfileState],
  ])("is hidden while the profile is %s", (_label, state) => {
    setProfileState(state);
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.COACH_NAV })).toBeNull();
  });

  // Same reasoning as the history link: the label is visually hidden at the
  // narrowest widths, so the accessible name has to come from text that is
  // always in the DOM.
  it("keeps an accessible name where the label is visually hidden", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    expect(screen.getByRole("link", { name: MESSAGES.COACH_NAV })).toBeDefined();
  });
});

describe("the rest of the header", () => {
  it("still offers the profile and sign out", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    expect(screen.getByRole("link", { name: MESSAGES.PROFILE_NAV })).toBeDefined();
    expect(screen.getByRole("button", { name: MESSAGES.SIGN_OUT })).toBeDefined();
  });

  // The profile link is how someone finishes onboarding, so it must survive
  // exactly the states that hide history.
  it("keeps the profile link when the profile is incomplete", () => {
    setProfileState({ status: "ready", profile: null });
    renderHeader();

    expect(screen.getByRole("link", { name: MESSAGES.PROFILE_NAV })).toBeDefined();
  });
});
