import { mock } from "bun:test";

// The single `aws-amplify/auth` stub.
//
// Amplify reaches for a configured Cognito pool on import, and the components
// under test only need the function to exist. It lives here rather than in
// whichever file happened to need it first because `mock.module` is global:
// two files registering it would replace each other, and a file that renders
// the Header without registering it at all gets the real module or the stub
// depending on which test ran first — which is a suite whose result depends on
// the order the runner picked.
//
// **A stub of a module must export everything that module's importers use.**
// This one exported `signOut` alone, which was true of the Header until it grew
// an admin link: `useIsAdmin` reads the `cognito:groups` claim through
// `fetchAuthSession`, so the moment Header imported it, every file rendering a
// Header failed to load with
//
//   SyntaxError: Export named 'fetchAuthSession' not found in module ...
//
// That killed Header.test.tsx and AppShell.test.tsx outright — their tests did
// not fail, they never ran — and it passed on Windows and failed on Linux CI,
// because the mock key does not match the same way on Windows so the real module
// loaded there. Exactly the hazard CLAUDE.md records for `mock.module`, reached
// from the other direction: not a stub leaking, a stub that was too small.

// EVERY export the app imports from `aws-amplify/auth`, not just the ones the
// current tests happen to reach.
//
// A stub only has to be missing one name to take a whole file out, and the file
// does not fail — it never loads, so its tests silently stop existing and the
// suite still reports green. Covering the module's full surface means adding an
// import to a component can never do that again. `grep -rn 'from "aws-amplify'
// src/` is the list this mirrors.
export const signOut = mock(async () => {});
export const getCurrentUser = mock(async () => ({
  username: "test-user",
  userId: "test-sub",
}));
export const signIn = mock(async () => ({ isSignedIn: true }));
export const signInWithRedirect = mock(async () => {});
export const signUp = mock(async () => ({ isSignUpComplete: false }));
export const confirmSignUp = mock(async () => ({ isSignUpComplete: true }));
export const autoSignIn = mock(async () => ({ isSignedIn: true }));
// The TOTP sign-in challenge (signin.tsx) and self-service enrolment
// (MfaSettings.tsx). Permissive shapes, matching the rest of this file — no
// test currently renders either caller, so these exist for the day one does
// rather than to model a real Cognito response.
export const confirmSignIn = mock(async () => ({
  isSignedIn: true,
  nextStep: { signInStep: "DONE" as const },
}));
export const setUpTOTP = mock(async () => ({
  sharedSecret: "TESTSECRET234567",
  getSetupUri: (appName: string) =>
    new URL(`otpauth://totp/${appName}?secret=TESTSECRET234567`),
}));
export const verifyTOTPSetup = mock(async () => {});
export const updateMFAPreference = mock(async () => {});
export const fetchMFAPreference = mock(async () => ({
  enabled: [] as string[],
  preferred: undefined as string | undefined,
}));

// Groups the fake access token carries. Mutable so a test can put the Header in
// the admin case and back without re-registering the module, which is not
// something `mock.module` supports doing twice.
let groups: string[] = [];

export const fetchAuthSession = mock(async () => ({
  tokens: {
    accessToken: {
      // The shape `isAdminSession` reads, and nothing more. Amplify's real
      // payload is far larger; reproducing it would be inventing detail no test
      // asserts on and that would rot the first time Cognito changed a claim.
      payload: { "cognito:groups": groups },
    },
  },
}));

/** Puts the stubbed session in the admin group, or takes it back out. */
export function setAmplifyGroups(next: string[]): void {
  groups = next;
}

export function resetAmplifyAuthStub(): void {
  for (const fn of [
    signOut,
    fetchAuthSession,
    getCurrentUser,
    signIn,
    signInWithRedirect,
    signUp,
    confirmSignUp,
    autoSignIn,
    confirmSignIn,
    setUpTOTP,
    verifyTOTPSetup,
    updateMFAPreference,
    fetchMFAPreference,
  ]) {
    fn.mockClear();
  }
  groups = [];
}

// `aws-amplify/utils` (the `Hub` used by lib/auth.tsx and pages/callback.tsx) is
// deliberately NOT stubbed here: nothing in the current test graph reaches it, and
// a stub nobody needs is another surface to keep complete. If a test ever renders
// AuthProvider, stub that module in this same file rather than in the test.
mock.module("aws-amplify/auth", () => ({
  signOut,
  fetchAuthSession,
  getCurrentUser,
  signIn,
  signInWithRedirect,
  signUp,
  confirmSignUp,
  autoSignIn,
  confirmSignIn,
  setUpTOTP,
  verifyTOTPSetup,
  updateMFAPreference,
  fetchMFAPreference,
}));
