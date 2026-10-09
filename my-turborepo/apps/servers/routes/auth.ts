import { timingSafeEqual } from "node:crypto";
import express, { type Response } from "express";
import {
  ConfirmSignupRequestSchema,
  SigninRequestSchema,
  SignupRequestSchema,
  TotpCodeSchema,
  type AuthErrorCode,
  type AuthStepResponse,
  type MeResponse,
  type MfaStatusResponse,
  type SignoutResponse,
  type TotpSetupResponse,
} from "@repo/shared";
import {
  clearCookie,
  clearSessionCookies,
  COOKIES,
  readAccessToken,
  readCookie,
  setCookie,
  setSessionCookies,
} from "../lib/authCookies";
import {
  buildGoogleAuthorizeUrl,
  confirmSignUp,
  disableTotp,
  exchangeAuthorizationCode,
  getTotpEnabled,
  hostedUiLogoutUrl,
  randomToken,
  refreshAccessToken,
  respondToTotp,
  revokeRefreshToken,
  signIn,
  signUp,
  startTotpSetup,
  verifyTotpSetup,
} from "../lib/cognitoUserAuth";
import { config } from "../lib/config";
import { AuthFlowError } from "../lib/errors";

// The browser's whole interface to Cognito (ADR-0011).
//
// Every success answers with cookies, never with a token in a body: the page
// learns WHERE a sign-in stands (`next`), and the session itself stays in
// httpOnly cookies it cannot read. Failures answer with a stable AuthErrorCode
// and nothing of Cognito's own text.
//
// Three routers, because they sit behind different middleware in index.ts:
//   - authRouter: public. Credential routes are rate limited per IP there.
//   - meRouter: behind AuthMiddleware, and NOT the API limiter — the web app
//     asks it on every load, and it costs one local JWT verification.
//   - mfaRouter: behind AuthMiddleware and the API limiter. Each call reaches
//     Cognito with the candidate's own access token.

export const authRouter = express.Router();
export const meRouter = express.Router();
export const mfaRouter = express.Router();

function sendCode(res: Response, status: number, code: AuthErrorCode): void {
  res.status(status).json({ code });
}

function sendStep(res: Response, next: AuthStepResponse["next"]): void {
  res.status(200).json({ next } satisfies AuthStepResponse);
}

// AuthFlowError is the candidate's to act on and says so; anything else is a
// dependency or configuration failure, logged in full and answered generically.
function sendFailure(res: Response, route: string, error: unknown): void {
  if (error instanceof AuthFlowError) {
    // 401s and 400s are ordinary (a wrong password); only a 5xx is worth a
    // stack's worth of attention, but every one is worth a line.
    console.warn(`[auth] ${route}: ${error.code} — ${error.message}`);
    sendCode(res, error.status, error.code);
    return;
  }
  console.error(`[auth] ${route} failed`, error);
  sendCode(res, 500, "FAILED");
}

// ---------------------------------------------------------------------------
// Password sign-in
// ---------------------------------------------------------------------------

// What the pending-TOTP cookie holds. Base64url JSON so the session string —
// opaque, and Cognito's to format — cannot collide with a separator.
type PendingTotp = { session: string; username: string };

function encodePending(pending: PendingTotp): string {
  return Buffer.from(JSON.stringify(pending)).toString("base64url");
}

function decodePending(raw: string | undefined): PendingTotp | null {
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "session" in value &&
      "username" in value &&
      typeof value.session === "string" &&
      typeof value.username === "string"
    ) {
      return { session: value.session, username: value.username };
    }
  } catch {
    // Falls through: a cookie this server did not write.
  }
  return null;
}

authRouter.post("/signin", async (req, res) => {
  const parsed = SigninRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendCode(res, 400, "INVALID_REQUEST");
    return;
  }

  try {
    const result = await signIn(parsed.data.email, parsed.data.password);
    switch (result.kind) {
      case "signedIn":
        clearCookie(res, COOKIES.pendingTotp);
        setSessionCookies(res, result.tokens);
        sendStep(res, "DONE");
        return;
      case "totp":
        setCookie(
          res,
          COOKIES.pendingTotp,
          encodePending({ session: result.session, username: result.username }),
        );
        sendStep(res, "TOTP");
        return;
      case "notConfirmed":
        sendStep(res, "CONFIRM_SIGN_UP");
        return;
    }
  } catch (error) {
    sendFailure(res, "signin", error);
  }
});

authRouter.post("/signin/totp", async (req, res) => {
  const parsed = TotpCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendCode(res, 400, "INVALID_REQUEST");
    return;
  }

  const pending = decodePending(readCookie(req, COOKIES.pendingTotp));
  if (pending === null) {
    sendCode(res, 401, "SIGNIN_EXPIRED");
    return;
  }

  try {
    const tokens = await respondToTotp(
      pending.username,
      pending.session,
      parsed.data.code,
    );
    clearCookie(res, COOKIES.pendingTotp);
    setSessionCookies(res, tokens);
    sendStep(res, "DONE");
  } catch (error) {
    // A wrong code leaves the pending sign-in usable, so the cookie stays and
    // the candidate retries without retyping their password. An expired one
    // is gone for good.
    if (error instanceof AuthFlowError && error.code === "SIGNIN_EXPIRED") {
      clearCookie(res, COOKIES.pendingTotp);
    }
    sendFailure(res, "signin/totp", error);
  }
});

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

authRouter.post("/signup", async (req, res) => {
  const parsed = SignupRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendCode(res, 400, "INVALID_REQUEST");
    return;
  }

  try {
    const { confirmed } = await signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      turnstileToken: parsed.data.turnstileToken,
    });
    if (!confirmed) {
      sendStep(res, "CONFIRM_SIGN_UP");
      return;
    }
    // Not reachable with this pool (it verifies email), but if it ever were,
    // the password is in hand and signing in now is what the user expects.
    const result = await signIn(parsed.data.email, parsed.data.password);
    if (result.kind === "signedIn") {
      setSessionCookies(res, result.tokens);
      sendStep(res, "DONE");
      return;
    }
    sendStep(res, result.kind === "totp" ? "TOTP" : "CONFIRM_SIGN_UP");
  } catch (error) {
    sendFailure(res, "signup", error);
  }
});

// Confirms the email. Does NOT sign in: Amplify's autoSignIn rode on a session
// it held in the browser, and the equivalent here would mean keeping the
// password between two requests. The candidate signs in once more instead.
authRouter.post("/confirm", async (req, res) => {
  const parsed = ConfirmSignupRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendCode(res, 400, "INVALID_REQUEST");
    return;
  }

  try {
    await confirmSignUp(parsed.data.email, parsed.data.code);
    res.status(204).end();
  } catch (error) {
    sendFailure(res, "confirm", error);
  }
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

// The client calls this after a 401 and retries once. It is a route of its own,
// rather than something AuthMiddleware does on every request, so the refresh
// cookie can be scoped to /api/v1/auth and never travel anywhere else.
authRouter.post("/refresh", async (req, res) => {
  const refreshToken = readCookie(req, COOKIES.refresh);
  const username = readCookie(req, COOKIES.username);
  if (refreshToken === undefined || username === undefined) {
    clearSessionCookies(res);
    sendCode(res, 401, "UNAUTHENTICATED");
    return;
  }

  try {
    const accessToken = await refreshAccessToken(refreshToken, username);
    setCookie(res, COOKIES.access, accessToken);
    res.status(204).end();
  } catch (error) {
    // Expired, revoked, or the account is gone: the session is over, so the
    // cookies go too, or every later request would repeat this failure.
    if (error instanceof AuthFlowError && error.code === "UNAUTHENTICATED") {
      clearSessionCookies(res);
    }
    sendFailure(res, "refresh", error);
  }
});

authRouter.post("/signout", async (req, res) => {
  const refreshToken = readCookie(req, COOKIES.refresh);
  const username = readCookie(req, COOKIES.username);

  // Revoking kills the refresh token and every access token issued from it,
  // so a copied cookie stops working too. Best effort: the cookies are
  // cleared regardless, because "Sign out" must sign out of this browser.
  if (refreshToken !== undefined) {
    try {
      await revokeRefreshToken(refreshToken);
    } catch (error) {
      console.warn("[auth] signout: revoke failed", error);
    }
  }
  clearSessionCookies(res);

  let logoutUrl: string | null = null;
  try {
    logoutUrl = hostedUiLogoutUrl(username);
  } catch (error) {
    console.warn("[auth] signout: no hosted-UI logout URL", error);
  }
  res.status(200).json({ logoutUrl } satisfies SignoutResponse);
});

// ---------------------------------------------------------------------------
// Google, through Cognito's hosted UI
// ---------------------------------------------------------------------------

function webUrl(path: string): string {
  return `${config.webAppOrigin}${path}`;
}

// Top-level navigations, not fetches: the browser is SENT here and onwards to
// Google. Failures therefore redirect back to the sign-in page rather than
// answering JSON nobody would read.
authRouter.get("/google", (_req, res) => {
  try {
    const state = randomToken();
    const verifier = randomToken();
    const authorizeUrl = buildGoogleAuthorizeUrl(state, verifier);
    // base64url never contains ".", so it is a safe separator.
    setCookie(res, COOKIES.oauthState, `${state}.${verifier}`);
    res.redirect(302, authorizeUrl);
  } catch (error) {
    console.error("[auth] google: could not start", error);
    res.redirect(302, webUrl("/signin?error=google"));
  }
});

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

authRouter.get("/google/callback", async (req, res) => {
  const stored = readCookie(req, COOKIES.oauthState);
  // Single use, whatever happens next.
  clearCookie(res, COOKIES.oauthState);

  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const [expectedState, verifier] = stored?.split(".") ?? [];

  // The state check is the CSRF control for this flow: without it a hostile
  // page could finish a sign-in it started, landing the candidate in the
  // attacker's account. A missing cookie means this browser never began it.
  if (
    code === undefined ||
    state === undefined ||
    expectedState === undefined ||
    verifier === undefined ||
    !sameString(state, expectedState)
  ) {
    console.warn("[auth] google/callback: state mismatch or missing code");
    res.redirect(302, webUrl("/signin?error=google"));
    return;
  }

  try {
    const tokens = await exchangeAuthorizationCode(code, verifier);
    setSessionCookies(res, tokens);
    res.redirect(302, webUrl("/callback"));
  } catch (error) {
    console.error("[auth] google/callback: exchange failed", error);
    res.redirect(302, webUrl("/signin?error=google"));
  }
});

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

meRouter.get("/", (req, res) => {
  const user = req.user;
  if (user === undefined) {
    sendCode(res, 401, "UNAUTHENTICATED");
    return;
  }
  res.status(200).json({
    id: user.id,
    username: user.username,
    groups: user.groups,
  } satisfies MeResponse);
});

// AuthMiddleware already verified this token; the MFA calls hand it to Cognito,
// which authorises them by it.
function accessTokenOrRefuse(
  req: express.Request,
  res: Response,
): string | undefined {
  const token = readAccessToken(req);
  if (token === undefined) sendCode(res, 401, "UNAUTHENTICATED");
  return token;
}

mfaRouter.get("/", async (req, res) => {
  const token = accessTokenOrRefuse(req, res);
  if (token === undefined) return;
  try {
    const enabled = await getTotpEnabled(token);
    res.status(200).json({ enabled } satisfies MfaStatusResponse);
  } catch (error) {
    sendFailure(res, "mfa", error);
  }
});

mfaRouter.post("/totp/setup", async (req, res) => {
  const token = accessTokenOrRefuse(req, res);
  if (token === undefined) return;
  try {
    const setup = await startTotpSetup(token);
    res.status(200).json(setup satisfies TotpSetupResponse);
  } catch (error) {
    sendFailure(res, "mfa/totp/setup", error);
  }
});

mfaRouter.post("/totp/verify", async (req, res) => {
  const parsed = TotpCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    sendCode(res, 400, "INVALID_REQUEST");
    return;
  }
  const token = accessTokenOrRefuse(req, res);
  if (token === undefined) return;
  try {
    await verifyTotpSetup(token, parsed.data.code);
    res.status(204).end();
  } catch (error) {
    sendFailure(res, "mfa/totp/verify", error);
  }
});

mfaRouter.delete("/totp", async (req, res) => {
  const token = accessTokenOrRefuse(req, res);
  if (token === undefined) return;
  try {
    await disableTotp(token);
    res.status(204).end();
  } catch (error) {
    sendFailure(res, "mfa/totp", error);
  }
});
