const env = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

// Comma-separated env lists (CORS origins, Bedrock model fallback chains).
//
// Throws on an empty result rather than returning []. `env()` only falls back
// when a variable is UNSET, so `FOO=""` would otherwise yield an empty list and
// fail far from its cause — an empty CORS allowlist rejects every origin, an
// empty model chain makes every agent call fail. Fail at boot instead.
const csvList = (key: string, value: string): string[] => {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (items.length === 0) {
    throw new Error(
      `${key} is set but contains no entries. ` +
        `Provide a comma-separated list, or unset it to use the default.`
    );
  }
  return items;
};

// Ordered fallback chain for the text agents (Planner, Evaluator, Coach).
// MUST stay in sync with `bedrock_text_model_ids` in
// `infra/terraform/modules/iam/variables.tf` — the task role is scoped to
// exactly these ARNs, so an id here that is missing there fails at runtime with
// AccessDenied, not at deploy time.
//
// The `us.` prefix on the Llama entry is a cross-region inference profile, not
// a typo. The bare `meta.llama4-scout-17b-instruct-v1:0` is rejected outright —
// "Invocation of model ID ... with on-demand throughput isn't supported" —
// which silently cost this chain its middle tier: every Ministral failure fell
// straight through to Qwen. Verified against Bedrock 2026-08-26.
const DEFAULT_TEXT_MODELS = [
  "mistral.ministral-3-8b-instruct",
  "us.meta.llama4-scout-17b-instruct-v1:0",
  "qwen.qwen3-coder-30b-a3b-v1:0",
].join(",");

export const config = {
  port:                   Number(env("PORT", "8000")),
  corsOrigins:            csvList("CORS_ORIGIN", env("CORS_ORIGIN", "http://localhost:3000")),
  // Caps the JSON parser. Every current route takes a small object; resume
  // uploads are multipart and will carry their own limit.
  jsonBodyLimit:          env("JSON_BODY_LIMIT", "16kb"),
  awsRegion:              env("AWS_REGION", "us-east-1"),
  bedrockTextModelIds:    csvList("BEDROCK_TEXT_MODEL_IDS", env("BEDROCK_TEXT_MODEL_IDS", DEFAULT_TEXT_MODELS)),
  githubApiBase:          env("GITHUB_API_BASE", "https://api.github.com"),
  // From `terraform output uploads_bucket_id`. Not requireEnv: only the upload
  // path needs it, and failing boot would take down /plan and auth with it.
  // `lib/s3.ts` raises a clear error if an upload is attempted while unset.
  uploadsBucket:          env("UPLOADS_BUCKET", ""),
  // Without a timeout a hung upstream holds the request open indefinitely and
  // requests pile up behind it.
  githubTimeoutMs:        Number(env("GITHUB_TIMEOUT_MS", "5000")),
  // The GitHub call is unauthenticated (60 req/hr per IP), so an unthrottled
  // route burns the shared quota for every user at once.
  rateLimitWindowMs:      Number(env("RATE_LIMIT_WINDOW_MS", "60000")),
  rateLimitMaxRequests:   Number(env("RATE_LIMIT_MAX_REQUESTS", "20")),
  cognitoUserPoolId:       requireEnv("COGNITO_USER_POOL_ID"),
  cognitoUserPoolClientId: requireEnv("COGNITO_USER_POOL_CLIENT_ID"),
} as const;
