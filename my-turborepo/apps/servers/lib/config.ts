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
        `Provide a comma-separated list, or unset it to use the default.`,
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

// The CORS allowlist. Exported, and pure, so the production rules are testable
// without re-importing this module under a different NODE_ENV.
//
// Outside production an unset CORS_ORIGIN means the local web app. In
// production it is refused outright: the old default quietly allowed
// http://localhost:3000 in a deployed service, and an unset variable should be
// a failed boot rather than a policy nobody chose. Every production origin must
// also be https://, since this is the list of pages trusted to call the API
// with a candidate's token.
export function resolveCorsOrigins(
  raw: string | undefined,
  production: boolean,
): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    if (production) {
      throw new Error(
        "CORS_ORIGIN must be set in production: a comma-separated list of " +
          "the https:// origins the web app is served from.",
      );
    }
    return ["http://localhost:3000"];
  }

  const origins = csvList("CORS_ORIGIN", raw);

  if (production) {
    const insecure = origins.filter((origin) => !origin.startsWith("https://"));
    if (insecure.length > 0) {
      throw new Error(
        `CORS_ORIGIN allows non-https origins in production: ${insecure.join(", ")}`,
      );
    }
    if (origins.includes("*") || origins.some((origin) => origin.includes("*"))) {
      throw new Error("CORS_ORIGIN may not contain a wildcard in production.");
    }
  }

  return origins;
}

const testTargetMinutes = (): number => {
  const raw = Number(env("INTERVIEW_TEST_TARGET_MINUTES", "6"));
  // A non-numeric or non-positive value would produce timers that fire
  // immediately or never. Falling back beats starting an interview whose clock
  // is nonsense.
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
};

export const config = {
  port: Number(env("PORT", "8000")),
  // True only outside production AND only when explicitly asked for.
  interviewTestMode:
    !isProduction() && env("INTERVIEW_TEST_MODE", "") === "false",
  interviewTestTargetMinutes: testTargetMinutes(),
  corsOrigins: resolveCorsOrigins(process.env.CORS_ORIGIN, isProduction()),
  // Caps the JSON parser. Every current route takes a small object; resume
  // uploads are multipart and will carry their own limit.
  jsonBodyLimit: env("JSON_BODY_LIMIT", "16kb"),
  awsRegion: env("AWS_REGION", "us-east-1"),
  bedrockTextModelIds: csvList(
    "BEDROCK_TEXT_MODEL_IDS",
    env("BEDROCK_TEXT_MODEL_IDS", DEFAULT_TEXT_MODELS),
  ),
  githubApiBase: env("GITHUB_API_BASE", "https://api.github.com"),
  // From `terraform output uploads_bucket_id`. Not requireEnv: only the upload
  // path needs it, and failing boot would take down /plan and auth with it.
  // `lib/s3.ts` raises a clear error if an upload is attempted while unset.
  uploadsBucket: env("UPLOADS_BUCKET", ""),
  // From `terraform output sessions_table_name`, and in deployed environments
  // from SSM at /prepilot/<env>/dynamodb/table_name. Never derived from the
  // environment name: deriving it is how a misconfigured dev deploy ends up
  // reading and writing prod's interviews. Same treatment as uploadsBucket —
  // not requireEnv, because only the persistence path needs it and failing boot
  // would take down auth and /plan with it.
  sessionsTable: env("SESSIONS_TABLE", ""),
  // From `terraform output eval_queue_url`. Same treatment as the two above:
  // not requireEnv, because only the post-interview path needs it and failing
  // boot would take down auth, /plan and the interview loop itself. `lib/sqs.ts`
  // raises a clear error if an enqueue is attempted while unset.
  evalQueueUrl: env("EVAL_QUEUE_URL", ""),
  // Without a timeout a hung upstream holds the request open indefinitely and
  // requests pile up behind it.
  githubTimeoutMs: Number(env("GITHUB_TIMEOUT_MS", "5000")),
  // The GitHub call is unauthenticated (60 req/hr per IP), so an unthrottled
  // route burns the shared quota for every user at once.
  rateLimitWindowMs: Number(env("RATE_LIMIT_WINDOW_MS", "60000")),
  rateLimitMaxRequests: Number(env("RATE_LIMIT_MAX_REQUESTS", "20")),
  // Where the limiter keeps its counts. `memory` is per process, so behind a
  // load balancer the real limit is `max x taskCount` and a restart forgets
  // everything. `dynamodb` shares one count across every task through the
  // sessions table — one extra write per API request. Set it to `dynamodb`
  // before running more than one task.
  rateLimitStore: env("RATE_LIMIT_STORE", "memory") === "dynamodb"
    ? ("dynamodb" as const)
    : ("memory" as const),

  // ---------------------------------------------------------------------------
  // Model spend
  // ---------------------------------------------------------------------------

  // Text-model generations one candidate may trigger per UTC day: Planner (on a
  // cache miss), Gap, Company Intel and Coach. The rate limiter bounds how FAST
  // someone can spend; this bounds how MUCH. At 20 req/min the limiter alone
  // allowed roughly 28,800 generations per account per day.
  //
  // Not the voice stream — that is metered by the interview quota — and not the
  // Evaluator, whose calls are bounded by the answers of a conducted interview.
  modelCallsPerDay: Number(env("MODEL_CALLS_PER_DAY", "40")),
  // Text-model generations against one session. A plan with a job description
  // and a company is three (Planner, Gap, Intel), so the default allows a couple
  // of re-plans and on-demand reruns before refusing.
  agentRunsPerSession: Number(env("AGENT_RUNS_PER_SESSION", "8")),
  cognitoUserPoolId: requireEnv("COGNITO_USER_POOL_ID"),
  cognitoUserPoolClientId: requireEnv("COGNITO_USER_POOL_CLIENT_ID"),

  // Which environment this process believes it is. Used as the only dimension on
  // every custom metric and to scope the admin surface in logs.
  //
  // Deliberately NOT derived from NODE_ENV: that is a two-valued flag the
  // framework and the test runner both set, and overloading it would make a
  // `dev` deploy publish metrics under whatever value happened to be there.
  // Same reasoning as `sessionsTable` never being derived from an environment
  // name — see the note on that field.
  appEnvironment: env("APP_ENV", "dev"),

  // ---------------------------------------------------------------------------
  // Admin surface
  // ---------------------------------------------------------------------------

  // The Cognito group whose members reach /api/v1/admin. Membership lives in
  // Cognito rather than in this config or in DynamoDB, so granting or revoking
  // it is one API call against the pool and needs no deploy — and the claim
  // arrives on a token the server already verifies, so there is nothing extra to
  // read or cache per request.
  //
  // Matches `aws_cognito_user_group.admins` in infra/terraform/modules/cognito.
  // A name here that does not exist there is not an error at boot: it silently
  // means nobody is an admin, which is the safe direction to fail.
  adminGroupName: env("ADMIN_GROUP_NAME", "admins"),

  // How many users one page of GET /admin/users asks Cognito for. 60 is
  // ListUsers' documented maximum; a smaller page would mean more round trips
  // for the same table.
  adminUserPageSize: Number(env("ADMIN_USER_PAGE_SIZE", "60")),

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  // CloudWatch namespace for every custom metric this service emits. Also what
  // the Terraform alarms and GET /admin/metrics query against, so the three have
  // to agree — a mismatch produces alarms in INSUFFICIENT_DATA forever and a
  // dashboard of empty series, neither of which fails loudly.
  metricsNamespace: env("METRICS_NAMESPACE", "PrepPilot/API"),

  // Emission is on by default and switched off in tests. EMF metrics are written
  // to stdout, so leaving this on under `bun test` would interleave metric JSON
  // with test output for every request the route suites make.
  metricsEnabled: env("METRICS_ENABLED", "true") === "true",
} as const;
