import { mock } from "bun:test";
import type { ProfileView } from "@repo/shared";

// The single `@/lib/profile` stub, shared by every test that needs one.
//
// It exists for the same reason `apps/servers/__tests__/helpers/bedrockStub.ts`
// does: `mock.module` is GLOBAL and permanent for the process, and Bun runs
// every test file in one process. Two files each registering their own
// `@/lib/profile` would not get one stub each — the later registration replaces
// the earlier one for everybody, and whichever file loaded first is left
// asserting against a stub whose state it cannot reach.
//
// That is not hypothetical on the server side: routes/plan.test.ts mocking
// `agents/planner` hijacked all 24 tests in agents/planner.test.ts on Linux CI
// while staying green on Windows. One registration, one place, no ordering
// hazard.
//
// `useProfile` reads from a context provider that fetches on mount. Stubbing
// the hook rather than standing up ProfileProvider keeps these tests about the
// component under test instead of about the fetch.

export type ProfileState =
  | { status: "loading" }
  | { status: "ready"; profile: ProfileView | null }
  | { status: "error"; message: string };

export const reload = mock(() => {});
export const setProfile = mock((_profile: ProfileView | null) => {});
export const clear = mock(() => {});

let profileState: ProfileState = { status: "loading" };

mock.module("@/lib/profile", () => ({
  useProfile: () => ({ ...profileState, reload, setProfile, clear }),
}));

/** A profile that has finished onboarding — the common case. */
export const COMPLETE_PROFILE: ProfileView = {
  userId: "user-1",
  username: "tharun",
  firstName: "Tharun",
  lastName: "Sekar",
  githubUsername: "Tharun2331",
  hasResume: true,
  repoCount: 2,
  profileVersion: 3,
  complete: true,
  updatedAt: "2026-09-09T12:00:00.000Z",
};

export function setProfileState(state: ProfileState): void {
  profileState = state;
}

export function resetProfileStub(): void {
  profileState = { status: "loading" };
  reload.mockClear();
  setProfile.mockClear();
  clear.mockClear();
}
