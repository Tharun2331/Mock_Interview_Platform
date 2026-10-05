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

// Cognito user pool — public client values, safe to ship to the browser
// (the app client has no secret; it uses SRP). Mirror these from the
// Terraform `cognito` module outputs whenever the pool is re-provisioned.
//
// `oauth` drives the hosted-UI redirect flow used for social sign-in (Google).
// `domain` is the pool's custom auth domain (`aws_acm_custom_domain` in the
// cognito module). The redirects are this page's own origin: each
// environment's app client lists only its own callback URLs, so the bundle
// needs no list of every environment, and Cognito's allowlist stays the
// control over where a sign-in code may be sent.
// Bun's bundler inlines these at build time. A missing var becomes the empty
// string, which would configure Amplify with an empty pool id and turn every
// auth call into an obscure runtime failure — so fail loudly at startup instead,
// the same way the server's `requireEnv` does.
// Where this bundle is being served from. Guarded because tests and tooling
// can import this module without a browser window.
const APP_ORIGIN: string =
  typeof window === "undefined" ? "" : window.location.origin;

const requirePublicEnv = (key: string, value: string | undefined): string => {
  if (!value) {
    throw new Error(
      `Missing required build-time variable: ${key}. ` +
        `Set it before running the build — see apps/web/build.ts.`,
    );
  }
  return value;
};

export const COGNITO = {
  region: requirePublicEnv("BUN_PUBLIC_REGION", process.env.BUN_PUBLIC_REGION),
  userPoolId: requirePublicEnv(
    "BUN_PUBLIC_COGNITO_USER_POOL_ID",
    process.env.BUN_PUBLIC_COGNITO_USER_POOL_ID,
  ),
  userPoolClientId: requirePublicEnv(
    "BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID",
    process.env.BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID,
  ),
  oauth: {
    // Per environment, since each pool has its own hosted-UI domain. The
    // default is dev's.
    domain:
      process.env.BUN_PUBLIC_COGNITO_DOMAIN !== undefined &&
      process.env.BUN_PUBLIC_COGNITO_DOMAIN.length > 0
        ? process.env.BUN_PUBLIC_COGNITO_DOMAIN
        : "auth.tharunsekar.xyz",
    // aws.cognito.signin.user.admin is requested here as well as allowed on
    // the app client (infra/terraform/modules/cognito): Cognito only grants a
    // scope that was BOTH allowed on the client and asked for in this
    // redirect's `scope` parameter, so listing it on one side alone still
    // issues a token missing it. Without it, every self-service Cognito call
    // — GetUser, and the whole MFA family — fails with "Access Token does not
    // have required scopes" for anyone who signed in through Google, no
    // matter how many times they sign out and back in.
    scopes: [
      "email",
      "openid",
      "profile",
      "phone",
      "aws.cognito.signin.user.admin",
    ],
    redirectSignIn: [`${APP_ORIGIN}/callback`],
    redirectSignOut: [APP_ORIGIN],
    responseType: "code",
  },
} as const;
