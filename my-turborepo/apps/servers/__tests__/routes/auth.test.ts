import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { createHmac } from "node:crypto";
import {
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  SetUserMFAPreferenceCommand,
  SignUpCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { pkceChallenge } from "../../lib/cognitoUserAuth";
import { config } from "../../lib/config";
import { authRouter, meRouter, mfaRouter } from "../../routes/auth";
import { mount, type MountedApp, type TestUser } from "../helpers/testApp";

// The auth routes over a real HTTP server and real cookies (ADR-0011).
//
// Cognito is mocked at the client class, so lib/cognitoUserAuth.ts — the
// SECRET_HASH, the challenge handling, the error mapping — runs for real. The
// hosted UI's token endpoint is a plain HTTPS call, faked by intercepting fetch
// for that one host and passing everything else through, because these tests
// call the app with fetch too.

const cognito = mockClient(CognitoIdentityProviderClient);

const PREFIX = "/api/v1/auth";
const EMAIL = "ada@example.com";
const USERNAME = "3f2a-sub-as-username";

function accessToken(username = USERNAME): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: "sub-1", username }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function expectedHash(username: string): string {
  return createHmac("sha256", config.cognitoServerClientSecret)
    .update(username + config.cognitoServerClientId)
    .digest("base64");
}

function cognitoError(name: string, message = "detail"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let apps: MountedApp[] = [];

async function publicApp(): Promise<string> {
  const app = await mount({ path: PREFIX, router: authRouter, user: null });
  apps.push(app);
  return `${app.url}${PREFIX}`;
}

async function signedInApp(
  path: "me" | "mfa",
  user: TestUser = { id: "sub-1", username: USERNAME, groups: ["admins"] },
): Promise<string> {
  const app = await mount({
    path: `${PREFIX}/${path}`,
    router: path === "me" ? meRouter : mfaRouter,
    user,
  });
  apps.push(app);
  return `${app.url}${PREFIX}/${path}`;
}

const post = (url: string, body?: unknown, cookie?: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

type ParsedCookie = { value: string; attributes: string };

// name -> value and the raw attribute string, from every Set-Cookie header.
function setCookies(response: Response): Map<string, ParsedCookie> {
  const cookies = new Map<string, ParsedCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), {
      value: decodeURIComponent(pair.slice(separator + 1)),
      attributes: attributes.join(";").toLowerCase(),
    });
  }
  return cookies;
}

function cleared(cookie: ParsedCookie | undefined): boolean {
  return (
    cookie !== undefined &&
    cookie.value === "" &&
    cookie.attributes.includes("expires=thu, 01 jan 1970")
  );
}

// The token endpoint fake. Records what was sent so tests can assert on it.
const realFetch = globalThis.fetch;
let tokenRequests: { headers: Headers; body: URLSearchParams }[] = [];
let tokenResponse: { status: number; body: unknown } = {
  status: 200,
  body: {},
};

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`https://${config.cognitoDomain}/`)) {
    tokenRequests.push({
      headers: new Headers(init?.headers),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    return new Response(JSON.stringify(tokenResponse.body), {
      status: tokenResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

beforeEach(() => {
  cognito.reset();
  tokenRequests = [];
  tokenResponse = { status: 200, body: {} };
});

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Password sign-in
// ---------------------------------------------------------------------------

describe("POST /signin", () => {
  it("signs in with SECRET_HASH and answers with cookies, never tokens", async () => {
    const token = accessToken();
    cognito.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { AccessToken: token, RefreshToken: "refresh-1" },
    });
    const url = await publicApp();

    const response = await post(`${url}/signin`, {
      email: EMAIL,
      password: "Secret1!",
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ next: "DONE" });
    // The whole point: no token in anything page script can read.
    expect(text).not.toContain(token);
    expect(text).not.toContain("refresh-1");

    const input = cognito.commandCalls(InitiateAuthCommand)[0]?.args[0].input;
    expect(input?.AuthFlow).toBe("USER_PASSWORD_AUTH");
    expect(input?.ClientId).toBe(config.cognitoServerClientId);
    expect(input?.AuthParameters?.SECRET_HASH).toBe(expectedHash(EMAIL));

    const cookies = setCookies(response);
    const access = cookies.get("pp_at");
    expect(access?.value).toBe(token);
    expect(access?.attributes).toContain("httponly");
    expect(access?.attributes).toContain("samesite=strict");
    expect(access?.attributes).toContain("path=/;");

    const refresh = cookies.get("pp_rt");
    expect(refresh?.value).toBe("refresh-1");
    expect(refresh?.attributes).toContain("httponly");
    expect(refresh?.attributes).toContain("path=/api/v1/auth");
    // Cognito's username, read off the token, for signing later refreshes.
    expect(cookies.get("pp_user")?.value).toBe(USERNAME);
  });

  it("holds a TOTP challenge in a cookie scoped to the sign-in route", async () => {
    cognito.on(InitiateAuthCommand).resolves({
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: "challenge-session",
      ChallengeParameters: { USER_ID_FOR_SRP: USERNAME },
    });
    const url = await publicApp();

    const response = await post(`${url}/signin`, {
      email: EMAIL,
      password: "Secret1!",
    });

    expect(await response.json()).toEqual({ next: "TOTP" });
    const cookies = setCookies(response);
    expect(cookies.has("pp_at")).toBe(false);
    const pending = cookies.get("pp_mfa");
    expect(pending?.attributes).toContain("httponly");
    expect(pending?.attributes).toContain("path=/api/v1/auth/signin");
    expect(pending?.value).not.toContain("challenge-session"); // encoded
  });

  // Same answer for both, or the endpoint says which emails have accounts.
  it("answers a wrong password and an unknown email identically", async () => {
    const url = await publicApp();

    cognito
      .on(InitiateAuthCommand)
      .rejects(
        cognitoError(
          "NotAuthorizedException",
          "Incorrect username or password.",
        ),
      );
    const wrong = await post(`${url}/signin`, { email: EMAIL, password: "x" });

    cognito
      .on(InitiateAuthCommand)
      .rejects(cognitoError("UserNotFoundException", "User does not exist."));
    const unknown = await post(`${url}/signin`, {
      email: EMAIL,
      password: "x",
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const [a, b] = [await wrong.text(), await unknown.text()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ code: "INVALID_CREDENTIALS" });
  });

  it("sends an unverified account to confirmation", async () => {
    cognito
      .on(InitiateAuthCommand)
      .rejects(cognitoError("UserNotConfirmedException"));
    const url = await publicApp();

    const response = await post(`${url}/signin`, {
      email: EMAIL,
      password: "Secret1!",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "CONFIRM_SIGN_UP" });
  });

  it("refuses a malformed body without calling Cognito", async () => {
    const url = await publicApp();

    const response = await post(`${url}/signin`, { email: "nope" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(cognito.commandCalls(InitiateAuthCommand)).toHaveLength(0);
  });
});

describe("POST /signin/totp", () => {
  async function pendingCookie(url: string): Promise<string> {
    cognito.on(InitiateAuthCommand).resolves({
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: "challenge-session",
      ChallengeParameters: { USER_ID_FOR_SRP: USERNAME },
    });
    const response = await post(`${url}/signin`, {
      email: EMAIL,
      password: "Secret1!",
    });
    return `pp_mfa=${encodeURIComponent(setCookies(response).get("pp_mfa")?.value ?? "")}`;
  }

  it("completes the sign-in with Cognito's username, not the email", async () => {
    const url = await publicApp();
    const cookie = await pendingCookie(url);
    cognito.on(RespondToAuthChallengeCommand).resolves({
      AuthenticationResult: {
        AccessToken: accessToken(),
        RefreshToken: "refresh-1",
      },
    });

    const response = await post(
      `${url}/signin/totp`,
      { code: "123456" },
      cookie,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "DONE" });
    const input = cognito.commandCalls(RespondToAuthChallengeCommand)[0]
      ?.args[0].input;
    expect(input?.Session).toBe("challenge-session");
    expect(input?.ChallengeResponses).toMatchObject({
      USERNAME,
      SOFTWARE_TOKEN_MFA_CODE: "123456",
      SECRET_HASH: expectedHash(USERNAME),
    });
    const cookies = setCookies(response);
    expect(cookies.get("pp_at")?.value).toBe(accessToken());
    expect(cleared(cookies.get("pp_mfa"))).toBe(true);
  });

  // The candidate retries without retyping their password.
  it("keeps the pending sign-in after a wrong code", async () => {
    const url = await publicApp();
    const cookie = await pendingCookie(url);
    cognito
      .on(RespondToAuthChallengeCommand)
      .rejects(cognitoError("CodeMismatchException"));

    const response = await post(
      `${url}/signin/totp`,
      { code: "000000" },
      cookie,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "CODE_INVALID" });
    expect(setCookies(response).has("pp_mfa")).toBe(false);
  });

  it("drops an expired pending sign-in", async () => {
    const url = await publicApp();
    const cookie = await pendingCookie(url);
    cognito
      .on(RespondToAuthChallengeCommand)
      .rejects(cognitoError("NotAuthorizedException", "Invalid session"));

    const response = await post(
      `${url}/signin/totp`,
      { code: "123456" },
      cookie,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "SIGNIN_EXPIRED" });
    expect(cleared(setCookies(response).get("pp_mfa"))).toBe(true);
  });

  it("refuses a code with no pending sign-in", async () => {
    const url = await publicApp();

    const response = await post(`${url}/signin/totp`, { code: "123456" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "SIGNIN_EXPIRED" });
    expect(cognito.commandCalls(RespondToAuthChallengeCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sign-up and confirmation
// ---------------------------------------------------------------------------

describe("POST /signup", () => {
  it("hands the Turnstile token to the pre sign-up trigger", async () => {
    cognito.on(SignUpCommand).resolves({ UserConfirmed: false });
    const url = await publicApp();

    const response = await post(`${url}/signup`, {
      email: EMAIL,
      password: "Secret1!",
      turnstileToken: "turnstile-abc",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "CONFIRM_SIGN_UP" });
    const input = cognito.commandCalls(SignUpCommand)[0]?.args[0].input;
    expect(input?.SecretHash).toBe(expectedHash(EMAIL));
    expect(input?.ValidationData).toEqual([
      { Name: "turnstileToken", Value: "turnstile-abc" },
    ]);
    expect(input?.UserAttributes).toEqual([{ Name: "email", Value: EMAIL }]);
  });

  it("names a failed human check rather than blaming the address", async () => {
    cognito
      .on(SignUpCommand)
      .rejects(
        cognitoError(
          "UserLambdaValidationException",
          "PreSignUp failed with error We could not confirm you are a person. Please try again..",
        ),
      );
    const url = await publicApp();

    const response = await post(`${url}/signup`, {
      email: EMAIL,
      password: "Secret1!",
      turnstileToken: "bad",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "HUMAN_CHECK_FAILED" });
  });

  // The server enforces the same password policy as the form and the pool.
  it("refuses a weak password before Cognito sees it", async () => {
    const url = await publicApp();

    const response = await post(`${url}/signup`, {
      email: EMAIL,
      password: "weak",
    });

    expect(response.status).toBe(400);
    expect(cognito.commandCalls(SignUpCommand)).toHaveLength(0);
  });
});

describe("POST /confirm", () => {
  it("confirms with SECRET_HASH", async () => {
    cognito.on(ConfirmSignUpCommand).resolves({});
    const url = await publicApp();

    const response = await post(`${url}/confirm`, {
      email: EMAIL,
      code: "123456",
    });

    expect(response.status).toBe(204);
    const input = cognito.commandCalls(ConfirmSignUpCommand)[0]?.args[0].input;
    expect(input?.SecretHash).toBe(expectedHash(EMAIL));
  });

  // An earlier attempt confirmed it and failed afterwards: done, not failed.
  it("treats an already-confirmed account as success", async () => {
    cognito
      .on(ConfirmSignUpCommand)
      .rejects(
        cognitoError(
          "NotAuthorizedException",
          "User cannot be confirmed. Current status is CONFIRMED",
        ),
      );
    const url = await publicApp();

    const response = await post(`${url}/confirm`, {
      email: EMAIL,
      code: "123456",
    });

    expect(response.status).toBe(204);
  });

  it("maps a wrong code", async () => {
    cognito
      .on(ConfirmSignUpCommand)
      .rejects(cognitoError("CodeMismatchException"));
    const url = await publicApp();

    const response = await post(`${url}/confirm`, {
      email: EMAIL,
      code: "123456",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "CODE_INVALID" });
  });
});

// ---------------------------------------------------------------------------
// Refresh and sign-out
// ---------------------------------------------------------------------------

describe("POST /refresh", () => {
  const sessionCookie = `pp_rt=refresh-1; pp_user=${USERNAME}`;

  it("renews the access token, signing with the stored username", async () => {
    const renewed = accessToken();
    cognito
      .on(InitiateAuthCommand)
      .resolves({ AuthenticationResult: { AccessToken: renewed } });
    const url = await publicApp();

    const response = await post(`${url}/refresh`, undefined, sessionCookie);

    expect(response.status).toBe(204);
    const input = cognito.commandCalls(InitiateAuthCommand)[0]?.args[0].input;
    expect(input?.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(input?.AuthParameters).toEqual({
      REFRESH_TOKEN: "refresh-1",
      SECRET_HASH: expectedHash(USERNAME),
    });
    const cookies = setCookies(response);
    expect(cookies.get("pp_at")?.value).toBe(renewed);
    // Not rotated, so not re-sent.
    expect(cookies.has("pp_rt")).toBe(false);
  });

  it("ends the session when the refresh token is dead", async () => {
    cognito
      .on(InitiateAuthCommand)
      .rejects(
        cognitoError("NotAuthorizedException", "Refresh Token has expired"),
      );
    const url = await publicApp();

    const response = await post(`${url}/refresh`, undefined, sessionCookie);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" });
    const cookies = setCookies(response);
    expect(cleared(cookies.get("pp_at"))).toBe(true);
    expect(cleared(cookies.get("pp_rt"))).toBe(true);
  });

  it("answers 401 with no session cookies, without calling Cognito", async () => {
    const url = await publicApp();

    const response = await post(`${url}/refresh`);

    expect(response.status).toBe(401);
    expect(cognito.commandCalls(InitiateAuthCommand)).toHaveLength(0);
  });
});

describe("POST /signout", () => {
  it("revokes the refresh token and clears every session cookie", async () => {
    cognito.on(RevokeTokenCommand).resolves({});
    const url = await publicApp();

    const response = await post(
      `${url}/signout`,
      undefined,
      `pp_rt=refresh-1; pp_user=${USERNAME}`,
    );

    expect(response.status).toBe(200);
    // A password sign-in has no hosted-UI session to end.
    expect(await response.json()).toEqual({ logoutUrl: null });
    const input = cognito.commandCalls(RevokeTokenCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      Token: "refresh-1",
      ClientId: config.cognitoServerClientId,
      ClientSecret: config.cognitoServerClientSecret,
    });
    const cookies = setCookies(response);
    for (const name of ["pp_at", "pp_rt", "pp_user", "pp_mfa"]) {
      expect(cleared(cookies.get(name))).toBe(true);
    }
  });

  // "Sign out" must sign out of this browser even when Cognito is down.
  it("clears the cookies even when revocation fails", async () => {
    cognito
      .on(RevokeTokenCommand)
      .rejects(cognitoError("InternalErrorException"));
    const url = await publicApp();

    const response = await post(`${url}/signout`, undefined, "pp_rt=refresh-1");

    expect(response.status).toBe(200);
    expect(cleared(setCookies(response).get("pp_rt"))).toBe(true);
  });

  // `Google_…` with a capital G: Cognito uses the provider name exactly as
  // configured. A lowercase fixture here once hid that every real Google
  // sign-out was missing this URL.
  it("returns the hosted-UI logout URL for a Google sign-in", async () => {
    cognito.on(RevokeTokenCommand).resolves({});
    const url = await publicApp();

    const response = await post(
      `${url}/signout`,
      undefined,
      "pp_rt=refresh-1; pp_user=Google_1093",
    );

    const { logoutUrl } = (await response.json()) as { logoutUrl: string };
    const logout = new URL(logoutUrl);
    expect(logout.origin).toBe(`https://${config.cognitoDomain}`);
    expect(logout.pathname).toBe("/logout");
    expect(logout.searchParams.get("logout_uri")).toBe(config.webAppOrigin);
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

describe("GET /google and /google/callback", () => {
  async function start(url: string) {
    const response = await fetch(`${url}/google`, { redirect: "manual" });
    const state = setCookies(response).get("pp_oauth");
    const [expectedState = "", verifier = ""] = (state?.value ?? "").split(".");
    return { response, state, expectedState, verifier };
  }

  it("redirects to Google through the hosted UI with state and PKCE", async () => {
    const url = await publicApp();

    const { response, state, expectedState, verifier } = await start(url);

    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("location") ?? "");
    expect(authorize.origin).toBe(`https://${config.cognitoDomain}`);
    expect(authorize.searchParams.get("identity_provider")).toBe("Google");
    expect(authorize.searchParams.get("client_id")).toBe(
      config.cognitoServerClientId,
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${config.apiPublicOrigin}/api/v1/auth/google/callback`,
    );
    expect(authorize.searchParams.get("state")).toBe(expectedState);
    expect(authorize.searchParams.get("code_challenge")).toBe(
      pkceChallenge(verifier),
    );
    // Lax, so it survives the cross-site redirect back from Google.
    expect(state?.attributes).toContain("samesite=lax");
    expect(state?.attributes).toContain("path=/api/v1/auth/google");
  });

  it("exchanges the code with the secret and verifier, then lands on /callback", async () => {
    const url = await publicApp();
    const { state, expectedState, verifier } = await start(url);
    const token = accessToken("Google_1093");
    tokenResponse = {
      status: 200,
      body: { access_token: token, refresh_token: "refresh-g", id_token: "x" },
    };

    const response = await fetch(
      `${url}/google/callback?code=auth-code&state=${expectedState}`,
      {
        redirect: "manual",
        headers: { Cookie: `pp_oauth=${state?.value ?? ""}` },
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${config.webAppOrigin}/callback`,
    );
    const sent = tokenRequests[0];
    expect(sent?.body.get("code")).toBe("auth-code");
    expect(sent?.body.get("code_verifier")).toBe(verifier);
    expect(sent?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(
        `${config.cognitoServerClientId}:${config.cognitoServerClientSecret}`,
      ).toString("base64")}`,
    );
    const cookies = setCookies(response);
    expect(cookies.get("pp_at")?.value).toBe(token);
    expect(cookies.get("pp_user")?.value).toBe("Google_1093");
    expect(cleared(cookies.get("pp_oauth"))).toBe(true);
  });

  // Login CSRF: a code this browser never asked for must not sign it in.
  it("refuses a callback whose state does not match, exchanging nothing", async () => {
    const url = await publicApp();
    const { state } = await start(url);

    const response = await fetch(
      `${url}/google/callback?code=auth-code&state=forged`,
      {
        redirect: "manual",
        headers: { Cookie: `pp_oauth=${state?.value ?? ""}` },
      },
    );

    expect(response.headers.get("location")).toBe(
      `${config.webAppOrigin}/signin?error=google`,
    );
    expect(tokenRequests).toHaveLength(0);
    expect(setCookies(response).has("pp_at")).toBe(false);
  });

  it("refuses a callback this browser never started", async () => {
    const url = await publicApp();

    const response = await fetch(
      `${url}/google/callback?code=auth-code&state=anything`,
      { redirect: "manual" },
    );

    expect(response.headers.get("location")).toBe(
      `${config.webAppOrigin}/signin?error=google`,
    );
    expect(tokenRequests).toHaveLength(0);
  });

  it("sends a failed exchange back to sign-in", async () => {
    const url = await publicApp();
    const { state, expectedState } = await start(url);
    tokenResponse = { status: 400, body: { error: "invalid_grant" } };

    const response = await fetch(
      `${url}/google/callback?code=used&state=${expectedState}`,
      {
        redirect: "manual",
        headers: { Cookie: `pp_oauth=${state?.value ?? ""}` },
      },
    );

    expect(response.headers.get("location")).toBe(
      `${config.webAppOrigin}/signin?error=google`,
    );
    expect(setCookies(response).has("pp_at")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

describe("GET /me", () => {
  it("reports the verified identity and groups", async () => {
    const url = await signedInApp("me");

    const response = await fetch(url);

    expect(await response.json()).toEqual({
      id: "sub-1",
      username: USERNAME,
      groups: ["admins"],
    });
  });
});

describe("MFA", () => {
  const cookie = `pp_at=${accessToken()}`;

  it("reads whether TOTP is on, authorised by the cookie's token", async () => {
    cognito.on(GetUserCommand).resolves({
      Username: USERNAME,
      UserAttributes: [],
      PreferredMfaSetting: "SOFTWARE_TOKEN_MFA",
    });
    const url = await signedInApp("mfa");

    const response = await fetch(url, { headers: { Cookie: cookie } });

    expect(await response.json()).toEqual({ enabled: true });
    expect(
      cognito.commandCalls(GetUserCommand)[0]?.args[0].input.AccessToken,
    ).toBe(accessToken());
  });

  it("starts enrolment with an otpauth URI labelled by email", async () => {
    cognito
      .on(AssociateSoftwareTokenCommand)
      .resolves({ SecretCode: "ABC234" });
    cognito.on(GetUserCommand).resolves({
      Username: USERNAME,
      UserAttributes: [{ Name: "email", Value: EMAIL }],
    });
    const url = await signedInApp("mfa");

    const response = await post(`${url}/totp/setup`, undefined, cookie);

    expect(await response.json()).toEqual({
      sharedSecret: "ABC234",
      setupUri:
        "otpauth://totp/PrepPilot:ada%40example.com?secret=ABC234&issuer=PrepPilot",
    });
  });

  // Verifying alone registers the device; the preference write turns it on.
  it("verifies the code and then turns TOTP on", async () => {
    cognito.on(VerifySoftwareTokenCommand).resolves({ Status: "SUCCESS" });
    cognito.on(SetUserMFAPreferenceCommand).resolves({});
    const url = await signedInApp("mfa");

    const response = await post(
      `${url}/totp/verify`,
      { code: "123456" },
      cookie,
    );

    expect(response.status).toBe(204);
    expect(
      cognito.commandCalls(SetUserMFAPreferenceCommand)[0]?.args[0].input
        .SoftwareTokenMfaSettings,
    ).toEqual({ Enabled: true, PreferredMfa: true });
  });

  it("leaves TOTP off when the code does not verify", async () => {
    cognito.on(VerifySoftwareTokenCommand).resolves({ Status: "ERROR" });
    const url = await signedInApp("mfa");

    const response = await post(
      `${url}/totp/verify`,
      { code: "123456" },
      cookie,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "CODE_INVALID" });
    expect(cognito.commandCalls(SetUserMFAPreferenceCommand)).toHaveLength(0);
  });

  it("turns TOTP off", async () => {
    cognito.on(SetUserMFAPreferenceCommand).resolves({});
    const url = await signedInApp("mfa");

    const response = await fetch(`${url}/totp`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(204);
    expect(
      cognito.commandCalls(SetUserMFAPreferenceCommand)[0]?.args[0].input
        .SoftwareTokenMfaSettings,
    ).toEqual({ Enabled: false, PreferredMfa: false });
  });

  // A revoked session on a settings screen is "sign in again", never
  // "incorrect password".
  it("reads a rejected token as an ended session", async () => {
    cognito
      .on(GetUserCommand)
      .rejects(
        cognitoError("NotAuthorizedException", "Access Token has been revoked"),
      );
    const url = await signedInApp("mfa");

    const response = await fetch(url, { headers: { Cookie: cookie } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" });
  });
});
