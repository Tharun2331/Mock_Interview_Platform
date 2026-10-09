# ADR-0011: Sessions in httpOnly cookies, with the API as the only Cognito client

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The web app signed candidates in with Amplify, which keeps the Cognito ID, access and **refresh** tokens in `localStorage`. Anything that runs script on the page can read `localStorage`, so one XSS bug — a compromised dependency, an injected string that reaches the DOM — would let an attacker copy the refresh token and act as the candidate from anywhere for up to 7 days. The Cognito module already noted this: the refresh lifetime was cut from 30 days to 7 for exactly that reason.

The defences until now were all about keeping script out (a strict CSP, React's escaping). None of them limits what an injected script can take once it is in.

## Decision

**The API is the only Cognito client. No token ever reaches page script.**

- **A backend-for-frontend.** Express owns sign-in (`USER_PASSWORD_AUTH`), the TOTP challenge, sign-up (Turnstile passed through as `ValidationData`), email confirmation, refresh, sign-out (`RevokeToken`), Google sign-in (the hosted UI's code exchanged server-side) and self-service MFA. Routes are under `/api/v1/auth`; see `docs/architecture/api.md`.
- **One confidential app client.** It has a secret, so a stolen authorization code or a copied client id is useless on its own. The public SRP client is deleted. Deleting it also invalidated every token still sitting in a browser that had used it. Terraform writes the secret into SSM as a `SecureString` on the server's environment path. That is an exception to the out-of-band rule in `infra/terraform/CLAUDE.md`: Cognito generates the value, so it is in state either way.
- **Tokens in cookies, not a server-side session store.** The access token is in `pp_at` (Path `/`). The refresh token (`pp_rt`) and the username a refresh must be signed with (`pp_user`) are scoped to `Path=/api/v1/auth`, so they ride on no other request and never on the interview WebSocket. All are httpOnly. All are `SameSite=Strict` except the Google `state`/PKCE cookie, which must survive the redirect back from Google, a cross-site navigation. In production all are `Secure` with `__Host-`/`__Secure-` prefixes, which stop a sibling subdomain from planting look-alikes; `api.tharunsekar.xyz` is an unrelated service on the same registrable domain.
- **Explicit refresh.** On a 401 the client calls `POST /auth/refresh` once and replays the request. It is a separate route rather than something `AuthMiddleware` does on every request, so the refresh cookie can be path-scoped. The client confirms the session (`GET /auth/me`) before opening the interview socket, because a refused handshake arrives as a bare dropped connection.
- **Lifetimes unchanged.** Access 1 hour, refresh 7 days.

### What cookies brought with them

A cookie is attached by the browser, not by the page, so two attacks that a Bearer header was immune to now need their own controls:

- **CSRF.** The web app and the API are different origins but the same site, which is why `SameSite=Strict` cookies still flow between them. `SameSite` does not stop a different origin on the same site. `lib/originCheck.ts` refuses any state-changing request whose `Origin` is outside the CORS allowlist. CORS sends `credentials: true` with an exact origin list. Google sign-in carries a `state` value, compared in constant time, against login CSRF.
- **Cross-site WebSocket hijacking.** A WebSocket handshake is not subject to CORS. The upgrade handler checks `Origin` before it verifies anything, so a hostile page cannot open an interview as the candidate.

Password-guessing now passes through Express rather than going straight to Cognito, so the credential routes have their own per-IP limiter (`authRateLimiter`).

## What this does and does not buy

**httpOnly stops a script from stealing the session. It does not stop a script from using it.** An XSS can still send requests from the open tab while it runs. What changes is the damage: the attacker loses the session when the tab closes, instead of walking away with a 7-day credential. The CSP is still the control for keeping script out, and it is now tighter: `connect-src` no longer lists Cognito, because the page never talks to Cognito.

## Consequences

- Confirming an email no longer signs the candidate in. Amplify's `autoSignIn` relied on a session it held in the browser, and the server-side equivalent would mean keeping the password between two requests. Sign-in opens with the email already filled in instead.
- Every candidate signed in through Amplify had to sign in once more.
- The web bundle carries no Cognito configuration at all. The deploy no longer injects the pool, the client or the hosted-UI domain, which also removes the old way a prod bundle could end up pointed at dev's pool.
- Amplify's leftover `localStorage` entries are deleted on the first load of the new bundle (`lib/legacyAuthCleanup.ts`).
- Playwright can no longer fake a session by seeding Amplify's `localStorage` keys. A test session has to come from a real sign-in.

## Rejected

- **Hybrid: Amplify signs in, then hands the tokens to the server.** The refresh token would still pass through page script at every sign-in, and there would be two sources of truth for the session.
- **A server-side session store** (an opaque id in the cookie, tokens in DynamoDB). It would allow instant revocation and smaller cookies, at the cost of a DynamoDB read on every request and a new item type. Cognito's `RevokeToken` plus 1-hour access tokens is enough revocation for this product.
- **Amplify's `CookieStorage`.** Its cookies are written by JavaScript, so JavaScript can read them. It moves the tokens without protecting them.
- **Server-side SRP.** SRP exists so the password never leaves the browser. In this design it reaches Express over TLS either way, so SRP would be code that protects nothing.

## Lessons from the rollout

- **Cognito names federated users after the provider exactly as configured:** `Google_1083…`, capital G. A lowercase prefix check meant no Google sign-out ever ended the hosted-UI session, so "Continue with Google" signed straight back into the previous account. Unit tests passed because their fixture used the same wrong shape. A browser walkthrough found it.
- **A toast raised in a page's first effect is dropped** when the toaster mounts after the routes, as it does in `App.tsx`. The "Google sign-in failed" message is deferred a tick for that reason.
