export const BACKEND_URL = "http://localhost:8000";

// Cognito user pool — public client values, safe to ship to the browser
// (the app client has no secret; it uses SRP). Mirror these from the
// Terraform `cognito` module outputs whenever the pool is re-provisioned.
//
// `oauth` drives the hosted-UI redirect flow used for social sign-in (Google).
// The values mirror the `cognito` module: `domain` is the custom auth domain
// (`aws_acm_custom_domain`), and the redirect arrays match the client's
// `callback_urls` / `logout_urls`. Amplify selects the entry whose origin
// matches the current `window.location.origin`, so dev and prod both work.
// Bun's bundler inlines these at build time. A missing var becomes the empty
// string, which would configure Amplify with an empty pool id and turn every
// auth call into an obscure runtime failure — so fail loudly at startup instead,
// the same way the server's `requireEnv` does.
const requirePublicEnv = (key: string, value: string | undefined): string => {
  if (!value) {
    throw new Error(
      `Missing required build-time variable: ${key}. ` +
        `Set it before running the build — see apps/web/build.ts.`
    );
  }
  return value;
};

export const COGNITO = {
  region: requirePublicEnv("BUN_PUBLIC_REGION", process.env.BUN_PUBLIC_REGION),
  userPoolId: requirePublicEnv(
    "BUN_PUBLIC_COGNITO_USER_POOL_ID",
    process.env.BUN_PUBLIC_COGNITO_USER_POOL_ID
  ),
  userPoolClientId: requirePublicEnv(
    "BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID",
    process.env.BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID
  ),
  oauth: {
    domain: "auth.tharunsekar.xyz",
    scopes: ["email", "openid", "profile", "phone"],
    redirectSignIn: [
      "http://localhost:3000/callback",
      "https://preppilot.tharunsekar.xyz/callback",
    ],
    redirectSignOut: [
      "http://localhost:3000",
      "https://preppilot.tharunsekar.xyz",
    ],
    responseType: "code",
  },
} as const;
