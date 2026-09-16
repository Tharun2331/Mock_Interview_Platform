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

export const signOut = mock(async () => {});

mock.module("aws-amplify/auth", () => ({ signOut }));

export function resetAmplifyAuthStub(): void {
  signOut.mockClear();
}
