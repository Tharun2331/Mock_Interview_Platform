// The API's base URL, inlined at build time from BUN_PUBLIC_API_URL.
//
// Falls back to the local dev server only when the variable is unset, which is
// the `bun --hot` workflow. A production bundle never takes the fallback:
// build.ts refuses to build without the variable, and refuses anything that is
// not https://. The interview WebSocket derives its scheme from this URL, so an
// https:// base is also what makes the socket wss:// rather than a plaintext
// ws:// stream of the candidate's voice and access token.
const DEV_BACKEND_URL = "http://localhost:8000";

export const BACKEND_URL: string =
  process.env.BUN_PUBLIC_API_URL !== undefined &&
  process.env.BUN_PUBLIC_API_URL.length > 0
    ? process.env.BUN_PUBLIC_API_URL
    : DEV_BACKEND_URL;

// The sign-up form's Turnstile site key: public by design, it is rendered into
// the page. Inlined at build time; build.ts refuses a production build without
// it. Empty only under `bun --hot` with no key in .env, where the form shows no
// check — fine while the pre sign-up trigger is in monitor mode, and a refused
// sign-up once it enforces.
export const TURNSTILE_SITE_KEY: string =
  process.env.BUN_PUBLIC_TURNSTILE_SITE_KEY ?? "";

// Upper bound on any single API call. Without one, axios waits forever: a
// request the server never answers leaves the form pinned on its progress bar
// with no error, no retry and nothing on screen that says anything is wrong.
//
// Generous rather than tight, because the slowest route is `/plan`, which runs
// a DynamoDB read, a Bedrock generation and a write — and the Bedrock client
// has its own per-attempt timeout across a three-model fallback chain. This has
// to outlast that, so the server's own error message wins the race and the
// client's timeout is only ever the last resort.
export const API_TIMEOUT_MS = 120_000;

// No Cognito configuration lives here any more (ADR-0011). The bundle never
// talks to Cognito: sign-in, Google's redirect and the session all go through
// the API, which keeps the tokens in httpOnly cookies. The pool, the client and
// the hosted-UI domain are the server's configuration alone.
