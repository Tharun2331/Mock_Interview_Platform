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
//
// Ministral stopped responding in us-east-1 on 2026-09-03 — the request was
// accepted, the connection opened, and no bytes were ever sent back. Not an
// error the SDK can classify: it surfaced only as `TimeoutError: Stream timed
// out because of no activity`, so every request paid 30s before falling through
// to Llama. It was demoted rather than removed, precisely so the chain could
// recover by itself if the model came back.
//
// It came back. Re-probed 2026-09-09 with `scripts/modelProbe.ts`:
//
//   mistral.ministral-3-8b-instruct           362ms
//   us.meta.llama4-scout-17b-instruct-v1:0    354ms
//   qwen.qwen3-coder-30b-a3b-v1:0            8796ms
//
// So Ministral is primary again, which restores the "Ministral 3 8B for text"
// locked decision in CLAUDE.md and matches the order `bedrock_text_model_ids`
// in infra/terraform/modules/iam/variables.tf already documented.
//
// Qwen stays last and the reason changed: it is no longer the fast fallback it
// was on 2026-09-03 (478ms), it is now roughly 25x slower than either model
// above it. That is a candidate watching a progress bar, so it is a last resort
// rather than a peer.
//
// The defences added during the outage stay, and are not tied to which model is
// first: MAX_ATTEMPTS 1, a 30s request timeout, and a warn log whenever a
// fallback answers. They are what made this failure cheap to diagnose and
// cheap to survive — removing them now would mean rediscovering it the hard way.
const DEFAULT_TEXT_MODELS = [
  "mistral.ministral-3-8b-instruct",
  "us.meta.llama4-scout-17b-instruct-v1:0",
  "qwen.qwen3-coder-30b-a3b-v1:0",
].join(",");

// Shortens an interview to a length that can actually be sat through while
// developing. A real plan is 15-40 minutes by schema, which makes testing the
// wrap-up nudges and the hard stop a 40-minute exercise per attempt.
//
// Gated on NODE_ENV twice over: the flag is only read outside production, and
// the value is ignored there even if something sets it. `npm start` sets
// NODE_ENV=production, so the deployed service cannot enter this mode by
// environment alone — someone would have to change this file.
//
// Deliberately NOT a change to PLAN_LIMITS. Those bounds are the product's
// contract: they are what the Planner's prompt states, what its output is
// validated against, and what every stored plan is re-validated against on
// read. Loosening them to make testing convenient would mean a six-minute plan
// could reach production and, worse, that the validation guarding real plans no
// longer describes real plans.
const isProduction = (): boolean => process.env.NODE_ENV === "production";

const testTargetMinutes = (): number => {
  const raw = Number(env("INTERVIEW_TEST_TARGET_MINUTES", "6"));
  // A non-numeric or non-positive value would produce timers that fire
  // immediately or never. Falling back beats starting an interview whose clock
  // is nonsense.
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
};

export const config = {
  port:                   Number(env("PORT", "8000")),
  // True only outside production AND only when explicitly asked for.
  interviewTestMode:      !isProduction() && env("INTERVIEW_TEST_MODE", "") === "false",
  interviewTestTargetMinutes: testTargetMinutes(),
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
  // From `terraform output sessions_table_name`, and in deployed environments
  // from SSM at /prepilot/<env>/dynamodb/table_name. Never derived from the
  // environment name: deriving it is how a misconfigured dev deploy ends up
  // reading and writing prod's interviews. Same treatment as uploadsBucket —
  // not requireEnv, because only the persistence path needs it and failing boot
  // would take down auth and /plan with it.
  sessionsTable:          env("SESSIONS_TABLE", ""),
  // From `terraform output eval_queue_url`. Same treatment as the two above:
  // not requireEnv, because only the post-interview path needs it and failing
  // boot would take down auth, /plan and the interview loop itself. `lib/sqs.ts`
  // raises a clear error if an enqueue is attempted while unset.
  evalQueueUrl:           env("EVAL_QUEUE_URL", ""),
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
