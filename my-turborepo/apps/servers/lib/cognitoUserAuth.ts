import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  AssociateSoftwareTokenCommand,
  ChallengeNameType,
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
import { z } from "zod";
import type { AuthErrorCode } from "@repo/shared";
import type { SessionTokens } from "./authCookies";
import { config } from "./config";
import { AUTH } from "./constants";
import { AuthFlowError, ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Candidate-side Cognito: sign-in, sign-up, refresh, Google's code exchange and
// self-service MFA, all through the confidential client (ADR-0011).
//
// Separate from lib/cognitoAdmin.ts for the reason that module gives: these are
// Cognito's public, per-user operations — every one is authorised by a password,
// a code or the user's own access token, never by AWS credentials — while that
// one calls the management API as the server's role. Keeping them apart keeps
// the trust boundaries legible.
export const cognitoUserClient = new CognitoIdentityProviderClient({
  region: config.awsRegion,
});

type ServerClient = { clientId: string; clientSecret: string; domain: string };

function serverClient(): ServerClient {
  const clientId = config.cognitoServerClientId;
  const clientSecret = config.cognitoServerClientSecret;
  const domain = config.cognitoDomain;
  if (clientId === "" || clientSecret === "" || domain === "") {
    throw new ServiceError(MESSAGES.AUTH_NOT_CONFIGURED);
  }
  return { clientId, clientSecret, domain };
}

// Base64(HMAC-SHA256(secret, username + clientId)), required on every call a
// confidential client makes on a user's behalf. The username must be the one
// the call names — an email at sign-in, Cognito's own username on a refresh.
export function secretHash(username: string, client: ServerClient): string {
  return createHmac("sha256", client.clientSecret)
    .update(username + client.clientId)
    .digest("base64");
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

// Which call failed decides what NotAuthorizedException means: a wrong password
// at sign-in, a stale pending sign-in at the TOTP step, a dead session anywhere
// else. One table for all of them is how a settings screen ends up telling a
// candidate their password was wrong when they never typed one.
type AuthContext = "signin" | "totp" | "signup" | "confirm" | "session";

const STATUS: Record<AuthErrorCode, number> = {
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  SIGNIN_EXPIRED: 401,
  NOT_CONFIRMED: 403,
  ACCOUNT_EXISTS: 409,
  MFA_NOT_FOUND: 409,
  CODE_INVALID: 400,
  CODE_EXPIRED: 400,
  PASSWORD_REQUIREMENTS: 400,
  EMAIL_NOT_ALLOWED: 400,
  HUMAN_CHECK_FAILED: 400,
  INVALID_REQUEST: 400,
  TOO_MANY_ATTEMPTS: 429,
  FAILED: 502,
};

export function authError(code: AuthErrorCode, detail?: string): AuthFlowError {
  return new AuthFlowError(code, STATUS[code], detail ?? code);
}

function notAuthorizedCode(context: AuthContext): AuthErrorCode {
  switch (context) {
    case "signin":
      // Shared with UserNotFoundException on purpose: telling them apart
      // would say which emails have accounts.
      return "INVALID_CREDENTIALS";
    case "totp":
      return "SIGNIN_EXPIRED";
    case "session":
      return "UNAUTHENTICATED";
    case "signup":
    case "confirm":
      return "FAILED";
  }
}

export function mapCognitoError(
  error: unknown,
  context: AuthContext,
): AuthFlowError {
  if (error instanceof AuthFlowError) return error;

  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${MESSAGES.AUTH_COGNITO_FAILED} ${name}: ${message}`;

  switch (name) {
    case "NotAuthorizedException":
      return authError(notAuthorizedCode(context), detail);
    case "UserNotFoundException":
      return authError(
        context === "signin"
          ? "INVALID_CREDENTIALS"
          : notAuthorizedCode(context),
        detail,
      );
    case "UserNotConfirmedException":
      return authError("NOT_CONFIRMED", detail);
    case "UsernameExistsException":
      return authError("ACCOUNT_EXISTS", detail);
    case "CodeMismatchException":
    case "EnableSoftwareTokenMFAException":
      return authError("CODE_INVALID", detail);
    case "ExpiredCodeException":
      return authError("CODE_EXPIRED", detail);
    case "InvalidPasswordException":
      return authError("PASSWORD_REQUIREMENTS", detail);
    case "UserLambdaValidationException":
      // The pre sign-up Lambda refuses a failed Turnstile check and a refused
      // address under this one name. Sending someone who failed the human
      // check off to find another address would fail the same way again.
      return authError(
        message.includes(AUTH.HUMAN_CHECK_REFUSAL_MARKER)
          ? "HUMAN_CHECK_FAILED"
          : "EMAIL_NOT_ALLOWED",
        detail,
      );
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return authError("TOO_MANY_ATTEMPTS", detail);
    case "SoftwareTokenMFANotFoundException":
      return authError("MFA_NOT_FOUND", detail);
    default:
      return authError("FAILED", detail);
  }
}

async function call<T>(
  context: AuthContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Configuration failures are not the candidate's to fix and must stay
    // ServiceErrors, not be flattened into an auth code.
    if (error instanceof ServiceError) throw error;
    throw mapCognitoError(error, context);
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const AccessClaimsSchema = z.object({
  username: z.string().min(1),
  sub: z.string().min(1),
});

// Reads `username` off an access token Cognito JUST returned over TLS.
// Deliberately a decode, not a verification: the token came from Cognito on
// this connection, not from a client. Every token a client presents is
// verified by AuthMiddleware.
export function usernameFromAccessToken(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    throw new ServiceError(`${MESSAGES.AUTH_COGNITO_FAILED} malformed token`);
  }
  const parsed = AccessClaimsSchema.safeParse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (!parsed.success) {
    throw new ServiceError(`${MESSAGES.AUTH_COGNITO_FAILED} token claims`);
  }
  return parsed.data.username;
}

type AuthResult = {
  AccessToken?: string | undefined;
  RefreshToken?: string | undefined;
};

function sessionTokens(result: AuthResult): SessionTokens {
  if (result.AccessToken === undefined || result.RefreshToken === undefined) {
    throw new ServiceError(`${MESSAGES.AUTH_COGNITO_FAILED} missing tokens`);
  }
  return {
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    username: usernameFromAccessToken(result.AccessToken),
  };
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export type SigninResult =
  | { kind: "signedIn"; tokens: SessionTokens }
  | { kind: "totp"; session: string; username: string }
  | { kind: "notConfirmed" };

export async function signIn(
  email: string,
  password: string,
): Promise<SigninResult> {
  const client = serverClient();

  try {
    const response = await cognitoUserClient.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: client.clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          SECRET_HASH: secretHash(email, client),
        },
      }),
    );

    if (response.AuthenticationResult !== undefined) {
      return {
        kind: "signedIn",
        tokens: sessionTokens(response.AuthenticationResult),
      };
    }

    if (
      response.ChallengeName === ChallengeNameType.SOFTWARE_TOKEN_MFA &&
      response.Session !== undefined
    ) {
      // The challenge must be answered with Cognito's own username, which for
      // this pool is not the email. USER_ID_FOR_SRP carries it on every
      // challenge, despite the name.
      return {
        kind: "totp",
        session: response.Session,
        username: response.ChallengeParameters?.USER_ID_FOR_SRP ?? email,
      };
    }

    // NEW_PASSWORD_REQUIRED and friends: only reachable for accounts an admin
    // created, which this product never does.
    throw new ServiceError(
      `${MESSAGES.AUTH_UNEXPECTED_CHALLENGE} ${response.ChallengeName ?? "none"}`,
    );
  } catch (error) {
    // Not a failure: the password was right, the email was never verified.
    if (error instanceof Error && error.name === "UserNotConfirmedException") {
      return { kind: "notConfirmed" };
    }
    if (error instanceof ServiceError) throw error;
    throw mapCognitoError(error, "signin");
  }
}

export async function respondToTotp(
  username: string,
  session: string,
  code: string,
): Promise<SessionTokens> {
  const client = serverClient();
  return call("totp", async () => {
    const response = await cognitoUserClient.send(
      new RespondToAuthChallengeCommand({
        ClientId: client.clientId,
        ChallengeName: ChallengeNameType.SOFTWARE_TOKEN_MFA,
        Session: session,
        ChallengeResponses: {
          USERNAME: username,
          SOFTWARE_TOKEN_MFA_CODE: code,
          SECRET_HASH: secretHash(username, client),
        },
      }),
    );
    if (response.AuthenticationResult === undefined) {
      throw new ServiceError(
        `${MESSAGES.AUTH_UNEXPECTED_CHALLENGE} ${response.ChallengeName ?? "none"}`,
      );
    }
    return sessionTokens(response.AuthenticationResult);
  });
}

// Renews the access token. Cognito returns no new refresh token (rotation is
// off, see the cognito module), so the caller keeps the one it has.
export async function refreshAccessToken(
  refreshToken: string,
  username: string,
): Promise<string> {
  const client = serverClient();
  return call("session", async () => {
    const response = await cognitoUserClient.send(
      new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: client.clientId,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
          SECRET_HASH: secretHash(username, client),
        },
      }),
    );
    const accessToken = response.AuthenticationResult?.AccessToken;
    if (accessToken === undefined) {
      throw new ServiceError(`${MESSAGES.AUTH_COGNITO_FAILED} empty refresh`);
    }
    return accessToken;
  });
}

// Revokes the refresh token and every access token issued from it. Best
// effort: sign-out clears the cookies whether or not this succeeds, because a
// candidate pressing "Sign out" must end up signed out in this browser.
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const client = serverClient();
  await cognitoUserClient.send(
    new RevokeTokenCommand({
      Token: refreshToken,
      ClientId: client.clientId,
      ClientSecret: client.clientSecret,
    }),
  );
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

export async function signUp(args: {
  email: string;
  password: string;
  turnstileToken: string | undefined;
}): Promise<{ confirmed: boolean }> {
  const client = serverClient();
  return call("signup", async () => {
    const response = await cognitoUserClient.send(
      new SignUpCommand({
        ClientId: client.clientId,
        SecretHash: secretHash(args.email, client),
        Username: args.email,
        Password: args.password,
        UserAttributes: [{ Name: "email", Value: args.email }],
        // Handed to the pre sign-up trigger, which verifies it with
        // Cloudflare. validationData is never stored on the user.
        ValidationData:
          args.turnstileToken === undefined
            ? undefined
            : [{ Name: "turnstileToken", Value: args.turnstileToken }],
      }),
    );
    return { confirmed: response.UserConfirmed === true };
  });
}

export async function confirmSignUp(
  email: string,
  code: string,
): Promise<void> {
  const client = serverClient();
  try {
    await cognitoUserClient.send(
      new ConfirmSignUpCommand({
        ClientId: client.clientId,
        SecretHash: secretHash(email, client),
        Username: email,
        ConfirmationCode: code,
      }),
    );
  } catch (error) {
    // A previous attempt already confirmed the account (and then failed
    // somewhere after). That is the outcome being asked for.
    if (
      error instanceof Error &&
      error.name === "NotAuthorizedException" &&
      error.message.includes("Current status is CONFIRMED")
    ) {
      return;
    }
    throw mapCognitoError(error, "confirm");
  }
}

// ---------------------------------------------------------------------------
// Google, through the hosted UI
// ---------------------------------------------------------------------------

export function randomToken(): string {
  return randomBytes(AUTH.OAUTH_RANDOM_BYTES).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function googleRedirectUri(): string {
  return `${config.apiPublicOrigin}${AUTH.ROUTE_PREFIX}/google/callback`;
}

export function buildGoogleAuthorizeUrl(
  state: string,
  verifier: string,
): string {
  const client = serverClient();
  const url = new URL(`https://${client.domain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    // Straight to Google, skipping Cognito's own provider picker.
    identity_provider: "Google",
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: googleRedirectUri(),
    scope: AUTH.OAUTH_SCOPES,
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const TokenEndpointResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

// The code goes back to Cognito with the client's secret (HTTP Basic) and the
// PKCE verifier. Neither is ever in the browser, so a code intercepted on the
// way back is worthless on its own.
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
): Promise<SessionTokens> {
  const client = serverClient();
  const credentials = Buffer.from(
    `${client.clientId}:${client.clientSecret}`,
  ).toString("base64");

  const response = await fetch(`https://${client.domain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code,
      redirect_uri: googleRedirectUri(),
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(AUTH.TOKEN_ENDPOINT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ServiceError(
      `${MESSAGES.AUTH_TOKEN_EXCHANGE_FAILED} HTTP ${response.status}`,
    );
  }
  const parsed = TokenEndpointResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ServiceError(`${MESSAGES.AUTH_TOKEN_EXCHANGE_FAILED} shape`);
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    username: usernameFromAccessToken(parsed.data.access_token),
  };
}

// Ends the hosted UI's own session for a Google sign-in. null for anyone else:
// a password sign-in never touched the hosted UI.
export function hostedUiLogoutUrl(username: string | undefined): string | null {
  if (
    username === undefined ||
    !username.toLowerCase().startsWith(AUTH.GOOGLE_USERNAME_PREFIX)
  ) {
    return null;
  }
  const client = serverClient();
  const url = new URL(`https://${client.domain}/logout`);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    logout_uri: config.webAppOrigin,
  }).toString();
  return url.toString();
}

// ---------------------------------------------------------------------------
// Self-service MFA, authorised by the candidate's own access token
// ---------------------------------------------------------------------------

const TOTP = "SOFTWARE_TOKEN_MFA";

export async function getTotpEnabled(accessToken: string): Promise<boolean> {
  return call("session", async () => {
    const user = await cognitoUserClient.send(
      new GetUserCommand({ AccessToken: accessToken }),
    );
    return (
      user.PreferredMfaSetting === TOTP ||
      (user.UserMFASettingList ?? []).includes(TOTP)
    );
  });
}

// otpauth://totp/<issuer>:<account>?secret=…&issuer=… — the format every
// authenticator app scans. The account label is the sign-in email, which is
// what the candidate's password manager already calls this account.
export function totpSetupUri(account: string, secret: string): string {
  const label = `${encodeURIComponent(AUTH.TOTP_ISSUER)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({ secret, issuer: AUTH.TOTP_ISSUER });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export async function startTotpSetup(
  accessToken: string,
): Promise<{ sharedSecret: string; setupUri: string }> {
  return call("session", async () => {
    const [association, user] = await Promise.all([
      cognitoUserClient.send(
        new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
      ),
      cognitoUserClient.send(new GetUserCommand({ AccessToken: accessToken })),
    ]);
    const secret = association.SecretCode;
    if (secret === undefined) {
      throw new ServiceError(`${MESSAGES.AUTH_COGNITO_FAILED} no secret`);
    }
    const email =
      user.UserAttributes?.find((attribute) => attribute.Name === "email")
        ?.Value ??
      user.Username ??
      AUTH.TOTP_ISSUER;
    return { sharedSecret: secret, setupUri: totpSetupUri(email, secret) };
  });
}

export async function verifyTotpSetup(
  accessToken: string,
  code: string,
): Promise<void> {
  return call("session", async () => {
    const verification = await cognitoUserClient.send(
      new VerifySoftwareTokenCommand({
        AccessToken: accessToken,
        UserCode: code,
      }),
    );
    if (verification.Status !== "SUCCESS") {
      throw authError("CODE_INVALID");
    }
    // The write that actually turns it on. Verifying alone registers the
    // device but leaves the account checking only a password.
    await cognitoUserClient.send(
      new SetUserMFAPreferenceCommand({
        AccessToken: accessToken,
        SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
      }),
    );
  });
}

export async function disableTotp(accessToken: string): Promise<void> {
  return call("session", async () => {
    await cognitoUserClient.send(
      new SetUserMFAPreferenceCommand({
        AccessToken: accessToken,
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      }),
    );
  });
}
