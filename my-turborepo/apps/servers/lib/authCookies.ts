import type { CookieOptions, Response } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { config } from "./config";
import { AUTH } from "./constants";

// The cookies that carry a session (ADR-0011).
//
// Every one is httpOnly: the point of the whole design is that no Cognito token
// is ever readable by page script, so an XSS can act inside an open tab but
// cannot carry a session away with it.
//
// Two more properties do real work here:
//
// - **Path scoping.** Only the access token goes to every route. The refresh
//   token, the pending TOTP sign-in and the OAuth state are scoped under
//   /api/v1/auth, so they ride on no other request and never reach the
//   interview WebSocket.
// - **Name prefixes when Secure.** `__Host-` (Path=/, no Domain) and `__Secure-`
//   make the browser refuse a same-named cookie planted by a sibling subdomain.
//   That matters on a shared registrable domain: api.tharunsekar.xyz is an
//   unrelated service, and without the prefix it could set
//   `Domain=.tharunsekar.xyz` cookies that shadow these. Prefixes require
//   Secure, so plain-http localhost uses the bare names.
//
// SameSite is Strict everywhere except the OAuth state. The web app and the API
// are different origins but the same site, so Strict cookies still flow on its
// fetches. The OAuth state has to survive a redirect chain that starts at
// accounts.google.com — a cross-site navigation, on which the browser drops
// Strict cookies — so it alone is Lax.

export type CookieSpec = {
  name: string;
  path: string;
  sameSite: "strict" | "lax";
  maxAgeMs: number;
};

function cookieName(base: string, path: string): string {
  if (!config.cookieSecure) return base;
  return path === "/" ? `__Host-${base}` : `__Secure-${base}`;
}

function spec(
  base: string,
  path: string,
  sameSite: CookieSpec["sameSite"],
  maxAgeMs: number,
): CookieSpec {
  return { name: cookieName(base, path), path, sameSite, maxAgeMs };
}

export const COOKIES = {
  access: spec("pp_at", "/", "strict", AUTH.ACCESS_COOKIE_MAX_AGE_MS),
  refresh: spec(
    "pp_rt",
    AUTH.ROUTE_PREFIX,
    "strict",
    AUTH.REFRESH_COOKIE_MAX_AGE_MS,
  ),
  // Cognito's username, beside the refresh token. A refresh with a client
  // secret must be signed (SECRET_HASH) with the username, and by then the
  // access token that names it has usually expired. Not a credential.
  username: spec(
    "pp_user",
    AUTH.ROUTE_PREFIX,
    "strict",
    AUTH.REFRESH_COOKIE_MAX_AGE_MS,
  ),
  // A password that checked out, waiting on a TOTP code: Cognito's challenge
  // session plus the username it belongs to. Held here rather than handed to
  // the page, because the session is half of a sign-in.
  pendingTotp: spec(
    "pp_mfa",
    `${AUTH.ROUTE_PREFIX}/signin`,
    "strict",
    AUTH.PENDING_TOTP_MAX_AGE_MS,
  ),
  oauthState: spec(
    "pp_oauth",
    `${AUTH.ROUTE_PREFIX}/google`,
    "lax",
    AUTH.OAUTH_STATE_MAX_AGE_MS,
  ),
} as const;

function options(cookie: CookieSpec): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: cookie.sameSite,
    path: cookie.path,
  };
}

export function setCookie(
  res: Response,
  cookie: CookieSpec,
  value: string,
): void {
  res.cookie(cookie.name, value, {
    ...options(cookie),
    maxAge: cookie.maxAgeMs,
  });
}

// Must repeat the path: a clear with a different path is a different cookie.
export function clearCookie(res: Response, cookie: CookieSpec): void {
  res.clearCookie(cookie.name, options(cookie));
}

export type SessionTokens = {
  accessToken: string;
  // Absent on a refresh: Cognito does not rotate it.
  refreshToken: string | null;
  username: string;
};

export function setSessionCookies(res: Response, tokens: SessionTokens): void {
  setCookie(res, COOKIES.access, tokens.accessToken);
  if (tokens.refreshToken !== null) {
    setCookie(res, COOKIES.refresh, tokens.refreshToken);
    setCookie(res, COOKIES.username, tokens.username);
  }
}

export function clearSessionCookies(res: Response): void {
  clearCookie(res, COOKIES.access);
  clearCookie(res, COOKIES.refresh);
  clearCookie(res, COOKIES.username);
  clearCookie(res, COOKIES.pendingTotp);
}

// Parses a Cookie header. Express 5 has no parser of its own, and the
// WebSocket upgrade needs one outside Express anyway.
//
// The FIRST occurrence of a name wins. Browsers send more specific paths first,
// so that is the cookie this server set for the route; a later duplicate is the
// shadowing attempt the name prefixes exist to stop.
export function parseCookieHeader(
  header: string | undefined,
): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name.length === 0 || cookies.has(name)) continue;

    const raw = pair.slice(separator + 1).trim();
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    try {
      cookies.set(name, decodeURIComponent(unquoted));
    } catch {
      // A malformed escape is not a cookie this server set. Skipped rather
      // than thrown, so one bad cookie cannot 500 every request.
    }
  }
  return cookies;
}

type HasHeaders = { headers: IncomingHttpHeaders };

export function readCookie(
  req: HasHeaders,
  cookie: CookieSpec,
): string | undefined {
  const value = parseCookieHeader(req.headers.cookie).get(cookie.name);
  return value === undefined || value.length === 0 ? undefined : value;
}

// The access token for this request: its httpOnly cookie, and nothing else.
//
// An `Authorization: Bearer` header is deliberately NOT read. It was accepted
// while the Amplify client still sent one (ADR-0011's transition) and went with
// the public app client. Keeping it would leave a second way in for a token
// lifted from somewhere else, which is exactly what this design removes.
export function readAccessToken(req: HasHeaders): string | undefined {
  return readCookie(req, COOKIES.access);
}
