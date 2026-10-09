import { describe, expect, it } from "bun:test";
import {
  COOKIES,
  parseCookieHeader,
  readAccessToken,
} from "../../lib/authCookies";

// setup.ts pins COOKIE_SECURE off, so these are the bare local-development
// names. The prefixed production names are a function of the same flag.

describe("parseCookieHeader", () => {
  it("parses and decodes pairs", () => {
    const cookies = parseCookieHeader("a=1; b=hello%20world; c=");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("hello world");
    expect(cookies.get("c")).toBe("");
  });

  // Browsers send the more specific path first, which is the cookie this
  // server set for the route; a later duplicate is a shadowing attempt.
  it("keeps the first occurrence of a name", () => {
    expect(parseCookieHeader("pp_at=mine; pp_at=planted").get("pp_at")).toBe(
      "mine",
    );
  });

  it("skips a malformed escape rather than throwing", () => {
    const cookies = parseCookieHeader("bad=%E0%A4%A; good=1");
    expect(cookies.has("bad")).toBe(false);
    expect(cookies.get("good")).toBe("1");
  });

  it("strips quotes and ignores nameless fragments", () => {
    const cookies = parseCookieHeader('q="quoted"; =orphan; junk');
    expect(cookies.get("q")).toBe("quoted");
    expect(cookies.size).toBe(1);
  });

  it("returns nothing for an absent header", () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
  });
});

describe("readAccessToken", () => {
  it("reads the access-token cookie", () => {
    expect(
      readAccessToken({ headers: { cookie: `${COOKIES.access.name}=tok` } }),
    ).toBe("tok");
  });

  // The Bearer path went with the Amplify client (ADR-0011). A token lifted
  // from anywhere else must not have a second way in.
  it("ignores an Authorization header entirely", () => {
    expect(
      readAccessToken({ headers: { authorization: "Bearer header-tok" } }),
    ).toBeUndefined();
  });

  it("does not let a header override the cookie", () => {
    expect(
      readAccessToken({
        headers: {
          cookie: `${COOKIES.access.name}=cookie-tok`,
          authorization: "Bearer header-tok",
        },
      }),
    ).toBe("cookie-tok");
  });

  it("finds nothing in an empty cookie", () => {
    expect(
      readAccessToken({ headers: { cookie: `${COOKIES.access.name}=` } }),
    ).toBeUndefined();
  });
});

describe("cookie scoping", () => {
  // The refresh token must ride on no route but the auth routes, and never on
  // the interview WebSocket.
  it("scopes everything but the access token under the auth routes", () => {
    expect(COOKIES.access.path).toBe("/");
    for (const cookie of [
      COOKIES.refresh,
      COOKIES.username,
      COOKIES.pendingTotp,
      COOKIES.oauthState,
    ]) {
      expect(cookie.path.startsWith("/api/v1/auth")).toBe(true);
    }
  });

  // The one Lax cookie: it has to survive the redirect back from Google, a
  // cross-site navigation on which Strict cookies are dropped.
  it("is Strict everywhere except the OAuth state", () => {
    expect(COOKIES.oauthState.sameSite).toBe("lax");
    for (const cookie of [
      COOKIES.access,
      COOKIES.refresh,
      COOKIES.username,
      COOKIES.pendingTotp,
    ]) {
      expect(cookie.sameSite).toBe("strict");
    }
  });
});
