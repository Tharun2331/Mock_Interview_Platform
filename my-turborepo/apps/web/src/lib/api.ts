import axios from "axios";
import { emitAuthEvent } from "@/lib/authEvents";
import { API_TIMEOUT_MS, BACKEND_URL } from "@/lib/config";
import { attachSessionRefresh } from "@/lib/sessionRefresh";

// The PrepPilot API clients. The session is an httpOnly cookie the server sets
// (ADR-0011), so there is no token here to attach: `withCredentials` is what
// makes the browser send the cookie on these cross-origin calls, and the page
// never sees what is in it.

// For every route behind the server's AuthMiddleware. A 401 triggers one
// refresh and one replay — see lib/sessionRefresh.ts.
export const api = axios.create({
  baseURL: BACKEND_URL,
  timeout: API_TIMEOUT_MS,
  withCredentials: true,
});

// For the auth routes themselves: sign-in, sign-up, refresh, sign-out. No
// refresh interceptor, deliberately — a 401 from POST /auth/signin is a wrong
// password, not an expired session, and a 401 from /auth/refresh retried
// through itself would never end.
export const authHttp = axios.create({
  baseURL: BACKEND_URL,
  timeout: API_TIMEOUT_MS,
  withCredentials: true,
});

export const AUTH_PATHS = {
  SIGNIN: "/api/v1/auth/signin",
  SIGNIN_TOTP: "/api/v1/auth/signin/totp",
  SIGNUP: "/api/v1/auth/signup",
  CONFIRM: "/api/v1/auth/confirm",
  REFRESH: "/api/v1/auth/refresh",
  SIGNOUT: "/api/v1/auth/signout",
  GOOGLE: "/api/v1/auth/google",
  ME: "/api/v1/auth/me",
  MFA: "/api/v1/auth/mfa",
  MFA_TOTP_SETUP: "/api/v1/auth/mfa/totp/setup",
  MFA_TOTP_VERIFY: "/api/v1/auth/mfa/totp/verify",
  MFA_TOTP: "/api/v1/auth/mfa/totp",
} as const;

attachSessionRefresh(api, {
  refresh: async () => {
    await authHttp.post(AUTH_PATHS.REFRESH);
  },
  onExpired: () => emitAuthEvent("expired"),
});
