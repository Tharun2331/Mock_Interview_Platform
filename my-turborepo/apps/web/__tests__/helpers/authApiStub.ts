import { mock } from "bun:test";
import type { AuthStep, MeResponse } from "@repo/shared";

// The single `@/lib/authApi` stub (ADR-0011). It replaced the aws-amplify/auth
// stub when sign-in moved to the API.
//
// lib/authApi is the network boundary for auth: every page and component that
// signs in, signs out or reads the session goes through it, so stubbing it here
// runs the real pages, guards, AuthProvider and error mapping over a fake
// server. It lives in one helper because `mock.module` is global and permanent
// for the process — two registrations replace each other, and a file that
// forgets to register would get the real module or the stub depending on which
// test ran first.
//
// **EVERY export of lib/authApi, not just the ones current tests reach.** A
// stub missing one name does not fail a test: the file importing it never
// loads, its tests silently stop existing, and the suite still reports green.
// That happened twice with the Amplify stub (see the Header tests). The list
// mirrors `export` in src/lib/authApi.ts.
//
// No lib/authApi.test.ts may exist while this stub does — it would load the
// stub instead of its subject. Its logic is thin by design; the parts worth
// testing live in lib/errors.ts and lib/sessionRefresh.ts, tested directly.

let groups: string[] = [];

const me = (): MeResponse => ({
  id: "test-sub",
  username: "test-user",
  groups,
});

export const signIn = mock(
  async (_email: string, _password: string): Promise<AuthStep> => "DONE",
);
export const confirmTotpSignIn = mock(
  async (_code: string): Promise<AuthStep> => "DONE",
);
export const signUp = mock(
  async (_args: {
    email: string;
    password: string;
    turnstileToken: string | undefined;
  }): Promise<AuthStep> => "CONFIRM_SIGN_UP",
);
export const confirmSignUp = mock(
  async (_email: string, _code: string): Promise<void> => {},
);
export const signOut = mock(
  async (): Promise<{ logoutUrl: string | null }> => ({ logoutUrl: null }),
);
export const fetchMe = mock(async (): Promise<MeResponse> => me());
export const startGoogleSignIn = mock((): void => {});
export const completeGoogleSignIn = mock(async (): Promise<void> => {});
export const fetchTotpEnabled = mock(async (): Promise<boolean> => false);
export const startTotpSetup = mock(async () => ({
  sharedSecret: "TESTSECRET234567",
  setupUri: "otpauth://totp/PrepPilot:test?secret=TESTSECRET234567",
}));
export const verifyTotpSetup = mock(async (_code: string): Promise<void> => {});
export const disableTotp = mock(async (): Promise<void> => {});

/** Puts the stubbed session in the admin group, or takes it back out. */
export function setSessionGroups(next: string[]): void {
  groups = next;
}

const all = [
  signIn,
  confirmTotpSignIn,
  signUp,
  confirmSignUp,
  signOut,
  fetchMe,
  startGoogleSignIn,
  completeGoogleSignIn,
  fetchTotpEnabled,
  startTotpSetup,
  verifyTotpSetup,
  disableTotp,
];

// mockReset, not mockClear: a test's mockImplementation must not leak into the
// next one. The defaults above are restored by re-applying them.
export function resetAuthApiStub(): void {
  for (const fn of all) fn.mockClear();
  signIn.mockImplementation(async () => "DONE");
  confirmTotpSignIn.mockImplementation(async () => "DONE");
  signUp.mockImplementation(async () => "CONFIRM_SIGN_UP");
  confirmSignUp.mockImplementation(async () => {});
  signOut.mockImplementation(async () => ({ logoutUrl: null }));
  fetchMe.mockImplementation(async () => me());
  completeGoogleSignIn.mockImplementation(async () => {});
  fetchTotpEnabled.mockImplementation(async () => false);
  verifyTotpSetup.mockImplementation(async () => {});
  disableTotp.mockImplementation(async () => {});
  groups = [];
}

mock.module("@/lib/authApi", () => ({
  signIn,
  confirmTotpSignIn,
  signUp,
  confirmSignUp,
  signOut,
  fetchMe,
  startGoogleSignIn,
  completeGoogleSignIn,
  fetchTotpEnabled,
  startTotpSetup,
  verifyTotpSetup,
  disableTotp,
}));
