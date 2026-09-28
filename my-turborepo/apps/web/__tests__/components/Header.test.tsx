import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
// The SHARED stubs, not local mock.module calls. Each of these modules is
// registered exactly once for the whole process — see the helpers' headers.
import {
  resetAmplifyAuthStub,
  setAmplifyGroups,
} from "../helpers/amplifyAuthStub";
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
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetProfileStub();
  resetAmplifyAuthStub();
});

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

    expect(
      screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV }),
    ).toBeNull();
  });

  it("is hidden for a candidate who has saved no profile yet", () => {
    setProfileState({ status: "ready", profile: null });
    renderHeader();

    expect(
      screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV }),
    ).toBeNull();
  });

  // Neither state knows whether the candidate may pass, and guessing wrong in
  // the permissive direction is the one that produces a bouncing link.
  it.each([
    ["loading", { status: "loading" } as ProfileState],
    ["errored", { status: "error", message: "network down" } as ProfileState],
  ])("is hidden while the profile is %s", (_label, state) => {
    setProfileState(state);
    renderHeader();

    expect(
      screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV }),
    ).toBeNull();
  });

  // The label is visually hidden on the narrowest screens, so the accessible
  // name has to come from text that is always in the DOM rather than from a
  // conditionally rendered span.
  it("keeps an accessible name even where the label is visually hidden", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    expect(
      screen.getByRole("link", { name: MESSAGES.HISTORY_NAV }),
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

    expect(
      screen.getByRole("link", { name: MESSAGES.COACH_NAV }),
    ).toBeDefined();
  });
});

describe("the rest of the header", () => {
  it("still offers the profile and sign out", () => {
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    expect(
      screen.getByRole("link", { name: MESSAGES.PROFILE_NAV }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: MESSAGES.SIGN_OUT }),
    ).toBeDefined();
  });

  // The profile link is how someone finishes onboarding, so it must survive
  // exactly the states that hide history.
  it("keeps the profile link when the profile is incomplete", () => {
    setProfileState({ status: "ready", profile: null });
    renderHeader();

    expect(
      screen.getByRole("link", { name: MESSAGES.PROFILE_NAV }),
    ).toBeDefined();
  });
});

// The admin link, and the reason this block exists at all.
//
// Header reads the `cognito:groups` claim through `fetchAuthSession` to decide
// whether to render it. When that import was added, the shared amplify stub
// exported only `signOut`, so this whole FILE stopped loading on Linux CI with
// "Export named 'fetchAuthSession' not found" — nine tests silently ceased to
// exist while the suite still reported green, and it passed on Windows because
// the mock key does not match there.
//
// These tests are what make that impossible to repeat quietly: they fail if the
// stub loses `fetchAuthSession`, rather than vanishing along with the file.
describe("the admin link", () => {
  it("is hidden for a candidate who is not in the admin group", async () => {
    setAmplifyGroups([]);
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    // `findBy` would wait for something that must never appear. The link is
    // rendered from an async claim read, so the absence is asserted after the
    // other nav items have settled.
    await screen.findByRole("link", { name: MESSAGES.HISTORY_NAV });
    expect(screen.queryByRole("link", { name: MESSAGES.ADMIN_NAV })).toBeNull();
  });

  it("appears for a member of the admin group", async () => {
    setAmplifyGroups(["admins"]);
    setProfileState({ status: "ready", profile: COMPLETE });
    renderHeader();

    const link = await screen.findByRole("link", { name: MESSAGES.ADMIN_NAV });
    expect(link.getAttribute("href")).toBe("/admin");
  });

  it("does not depend on the candidate having onboarded", async () => {
    // Gated on the group claim alone, NOT on `showHistory`. An operator has no
    // reason to have uploaded a resume, and tying the two would hide the admin
    // link from exactly the person who needs it.
    setAmplifyGroups(["admins"]);
    setProfileState({ status: "ready", profile: null });
    renderHeader();

    await screen.findByRole("link", { name: MESSAGES.ADMIN_NAV });
    expect(
      screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV }),
    ).toBeNull();
  });
});
