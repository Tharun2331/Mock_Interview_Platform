import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ProfileView } from "@repo/shared";

type ProfileState =
  | { status: "loading" }
  | { status: "ready"; profile: ProfileView | null }
  | { status: "error"; message: string };

let profileState: ProfileState = { status: "loading" };

mock.module("@/lib/profile", () => ({
  useProfile: () => ({
    ...profileState,
    reload: () => {},
    setProfile: () => {},
    clear: () => {},
  }),
}));

// Amplify reaches for a configured Cognito pool on import; the header only
// needs the function to exist.
mock.module("aws-amplify/auth", () => ({ signOut: async () => {} }));

const { Header } = await import("@/components/layout/Header");
const { MESSAGES } = await import("@/lib/messages");
const { MemoryRouter } = await import("react-router");

const COMPLETE: ProfileView = {
  userId: "user-1",
  username: "tharun",
  firstName: "Tharun",
  lastName: "Sekar",
  githubUsername: "Tharun2331",
  hasResume: true,
  repoCount: 2,
  profileVersion: 3,
  complete: true,
  updatedAt: "2026-09-12T10:00:00.000Z",
};

function renderHeader(path = "/start") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>
  );
}

beforeEach(() => {
  profileState = { status: "loading" };
});

afterEach(cleanup);

describe("the history link", () => {
  it("points at the history page for a complete profile", () => {
    profileState = { status: "ready", profile: COMPLETE };
    renderHeader();

    const link = screen.getByRole("link", { name: MESSAGES.HISTORY_NAV });
    expect(link.getAttribute("href")).toBe("/history");
  });

  // /history sits inside RequireProfile. Shown earlier it would be a link that
  // bounces straight back to onboarding, which reads as the app refusing rather
  // than as a guard doing its job.
  it("is hidden while the profile is incomplete", () => {
    profileState = {
      status: "ready",
      profile: { ...COMPLETE, complete: false, hasResume: false },
    };
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV })).toBeNull();
  });

  it("is hidden for a candidate who has saved no profile yet", () => {
    profileState = { status: "ready", profile: null };
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV })).toBeNull();
  });

  // Neither state knows whether the candidate may pass, and guessing wrong in
  // the permissive direction is the one that produces a bouncing link.
  it.each([
    ["loading", { status: "loading" } as ProfileState],
    ["errored", { status: "error", message: "network down" } as ProfileState],
  ])("is hidden while the profile is %s", (_label, state) => {
    profileState = state;
    renderHeader();

    expect(screen.queryByRole("link", { name: MESSAGES.HISTORY_NAV })).toBeNull();
  });

  // The label is visually hidden on the narrowest screens, so the accessible
  // name has to come from text that is always in the DOM rather than from a
  // conditionally rendered span.
  it("keeps an accessible name even where the label is visually hidden", () => {
    profileState = { status: "ready", profile: COMPLETE };
    renderHeader();

    expect(
      screen.getByRole("link", { name: MESSAGES.HISTORY_NAV })
    ).toBeDefined();
  });
});

describe("the rest of the header", () => {
  it("still offers the profile and sign out", () => {
    profileState = { status: "ready", profile: COMPLETE };
    renderHeader();

    expect(screen.getByRole("link", { name: MESSAGES.PROFILE_NAV })).toBeDefined();
    expect(screen.getByRole("button", { name: MESSAGES.SIGN_OUT })).toBeDefined();
  });

  // The profile link is how someone finishes onboarding, so it must survive
  // exactly the states that hide history.
  it("keeps the profile link when the profile is incomplete", () => {
    profileState = { status: "ready", profile: null };
    renderHeader();

    expect(screen.getByRole("link", { name: MESSAGES.PROFILE_NAV })).toBeDefined();
  });
});
