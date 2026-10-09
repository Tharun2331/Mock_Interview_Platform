import {
  AuthStepResponseSchema,
  MeResponseSchema,
  MfaStatusResponseSchema,
  SignoutResponseSchema,
  TotpSetupResponseSchema,
  type AuthStep,
  type MeResponse,
  type TotpSetupResponse,
} from "@repo/shared";
import { api, AUTH_PATHS, authHttp } from "@/lib/api";
import { emitAuthEvent } from "@/lib/authEvents";
import { BACKEND_URL } from "@/lib/config";
import { toAuthApiError } from "@/lib/errors";
import { UnexpectedResponseError } from "@/lib/profileApi";

// The browser's whole interface to sign-in (ADR-0011). It replaced Amplify:
// the server talks to Cognito and keeps the session in httpOnly cookies, so
// nothing here ever receives a token — only where a sign-in stands.
//
// Failures throw an AuthApiError carrying the server's code (see lib/errors),
// which pages turn into copy with errorMessage / mfaErrorMessage.
//
// Tests replace this module wholesale through __tests__/helpers/authApiStub.ts,
// so every export here must exist there too.

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toAuthApiError(error);
  }
}

function parseStep(data: unknown): AuthStep {
  const parsed = AuthStepResponseSchema.safeParse(data);
  if (!parsed.success) throw new UnexpectedResponseError();
  return parsed.data.next;
}

// `DONE` has set the session cookies; announce it so AuthProvider flips to
// signed in before the page navigates into a guarded route.
function settle(step: AuthStep): AuthStep {
  if (step === "DONE") emitAuthEvent("signedIn");
  return step;
}

export async function signIn(
  email: string,
  password: string,
): Promise<AuthStep> {
  return call(async () => {
    const response = await authHttp.post(AUTH_PATHS.SIGNIN, {
      email,
      password,
    });
    return settle(parseStep(response.data));
  });
}

// Continues the sign-in the password step started. The pending Cognito session
// is in an httpOnly cookie, so only the code travels.
export async function confirmTotpSignIn(code: string): Promise<AuthStep> {
  return call(async () => {
    const response = await authHttp.post(AUTH_PATHS.SIGNIN_TOTP, { code });
    return settle(parseStep(response.data));
  });
}

export async function signUp(args: {
  email: string;
  password: string;
  turnstileToken: string | undefined;
}): Promise<AuthStep> {
  return call(async () => {
    const response = await authHttp.post(AUTH_PATHS.SIGNUP, args);
    return settle(parseStep(response.data));
  });
}

export async function confirmSignUp(
  email: string,
  code: string,
): Promise<void> {
  await call(() => authHttp.post(AUTH_PATHS.CONFIRM, { email, code }));
}

// Ends the session server-side (the refresh token is revoked) and clears the
// cookies. Returns the hosted-UI logout URL for a Google sign-in, which the
// caller must visit or the next "Continue with Google" signs straight back in.
export async function signOut(): Promise<{ logoutUrl: string | null }> {
  try {
    const response = await authHttp.post(AUTH_PATHS.SIGNOUT);
    const parsed = SignoutResponseSchema.safeParse(response.data);
    return { logoutUrl: parsed.success ? parsed.data.logoutUrl : null };
  } finally {
    // Signed out in this tab either way: the server clears the cookies even
    // when revocation fails, and a page that still believed in the session
    // would only meet 401s.
    emitAuthEvent("signedOut");
  }
}

// Through `api`, not authHttp: an access token that lapsed while the tab sat
// open is refreshed and the call replayed, so a returning candidate is still
// signed in. Rejects when there is no session at all.
export async function fetchMe(): Promise<MeResponse> {
  const response = await api.get(AUTH_PATHS.ME);
  const parsed = MeResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();
  return parsed.data;
}

// Google goes through the server, by navigation rather than fetch: the server
// sets its state cookie, sends the browser to Google, and lands it on
// /callback with the session cookies already set.
export function startGoogleSignIn(): void {
  window.location.assign(`${BACKEND_URL}${AUTH_PATHS.GOOGLE}`);
}

// The /callback page: the server has set the cookies, if the sign-in worked.
// Confirms there is a session and announces it.
export async function completeGoogleSignIn(): Promise<void> {
  await fetchMe();
  emitAuthEvent("signedIn");
}

// ---------------------------------------------------------------------------
// Self-service MFA. All through `api`, so an expired access token is renewed.
// ---------------------------------------------------------------------------

export async function fetchTotpEnabled(): Promise<boolean> {
  return call(async () => {
    const response = await api.get(AUTH_PATHS.MFA);
    const parsed = MfaStatusResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new UnexpectedResponseError();
    return parsed.data.enabled;
  });
}

export async function startTotpSetup(): Promise<TotpSetupResponse> {
  return call(async () => {
    const response = await api.post(AUTH_PATHS.MFA_TOTP_SETUP);
    const parsed = TotpSetupResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new UnexpectedResponseError();
    return parsed.data;
  });
}

// Verifies the first code AND turns TOTP on; the server does both, because a
// verified device that is not the preferred method leaves the account checking
// only a password.
export async function verifyTotpSetup(code: string): Promise<void> {
  await call(() => api.post(AUTH_PATHS.MFA_TOTP_VERIFY, { code }));
}

export async function disableTotp(): Promise<void> {
  await call(() => api.delete(AUTH_PATHS.MFA_TOTP));
}
