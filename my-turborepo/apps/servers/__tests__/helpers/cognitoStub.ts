import { mock } from "bun:test";

// The single `lib/cognitoAuth` stub.
//
// `mock.module` is global and permanent for the process, so this lives in a
// helper rather than in whichever test needed it first — see the header of
// bedrockStub.ts for the CI-only failure that rule exists to prevent.
//
// **Hazard, stated plainly:** `lib/cognitoAuth.ts` has no test of its own
// today. The moment somebody writes `cognitoAuth.test.ts`, this registration
// will hijack it — the real verifier will never load. Whoever writes that file
// must stub `aws-jwt-verify` instead, or move this stub behind a flag first.
//
// Only routes/interview.ts reads `verifier` directly. Every HTTP route is
// mounted by testApp.ts without the middleware chain, so `AuthMiddleware` is
// re-exported here purely so this module keeps the same shape as the real one
// — replacing a module replaces ALL of its exports, and a missing one is an
// import error rather than a fallback.

export type StubbedClaims = { sub: string; username: string };

let claims: StubbedClaims = { sub: "user-1", username: "tharun" };
let failure: Error | null = null;

/** Stands in for `CognitoJwtVerifier.verify`. Resolves the configured claims,
 *  or rejects when the test is exercising the 401 path. */
export const verify = mock(async (_token: string): Promise<StubbedClaims> => {
  if (failure !== null) throw failure;
  return claims;
});

export const verifier = { verify };

// Never exercised — testApp.ts substitutes its own auth — but present so the
// replaced module exports everything the real one does.
export const AuthMiddleware = async (
  _req: unknown,
  _res: unknown,
  next: () => void,
): Promise<void> => next();

mock.module("../../lib/cognitoAuth", () => ({ verifier, AuthMiddleware }));

/** Who the next handshake authenticates as. */
export function setClaims(next: StubbedClaims): void {
  claims = next;
  failure = null;
}

/** An expired or forged token — the handshake must be refused before a socket
 *  exists, so no Sonic stream is ever allocated for it. */
export function setTokenRejected(error = new Error("JwtExpiredError")): void {
  failure = error;
}

export function resetCognitoStub(): void {
  claims = { sub: "user-1", username: "tharun" };
  failure = null;
  verify.mockClear();
}
