// Preloaded by bunfig.toml before any test module is imported.
//
// lib/config.ts is the single process.env boundary and it reads at module
// scope, throwing on a missing COGNITO_* pair. Every route imports it
// transitively, so without this no route test can even load its subject.
//
// Assigned unconditionally, NOT with `??=`. Bun auto-loads `apps/servers/.env`,
// which carries the developer's real dev table, bucket and user pool. Falling
// back to those would make tests environment-dependent — passing locally and
// failing in CI where no `.env` exists, or vice versa — and would point every
// command that escaped its mock at real infrastructure. Tests must describe the
// same world on every machine.
process.env.COGNITO_USER_POOL_ID = "us-east-1_test000000";
process.env.COGNITO_USER_POOL_CLIENT_ID = "testclientid0000000000000";
// The client's secret (ADR-0011). A developer's .env carries the real dev
// secret, so it is pinned like the rest.
process.env.COGNITO_USER_POOL_CLIENT_SECRET = "testclientsecret";
process.env.COGNITO_DOMAIN = "auth.test.invalid";
process.env.API_PUBLIC_ORIGIN = "http://localhost:8000";
process.env.WEB_APP_ORIGIN = "http://localhost:3000";
// Bare cookie names and no Secure flag, the local-development shape.
process.env.COOKIE_SECURE = "";
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "10";
process.env.SESSIONS_TABLE = "prepilot-sessions-test";
process.env.UPLOADS_BUCKET = "prepilot-uploads-test";
process.env.EVAL_QUEUE_URL =
  "https://sqs.us-east-1.amazonaws.com/000000000000/prepilot-eval-test";
process.env.AWS_REGION = "us-east-1";

// No guardrail. Blank, not deleted: a developer's .env may name the dev
// guardrail, and an unpinned one would wrap every user turn in guardContent on
// that machine only. lib/guardrail.ts is tested directly instead.
process.env.BEDROCK_GUARDRAIL_ID = "";
process.env.BEDROCK_GUARDRAIL_VERSION = "";
// The eval queue's receive limit, pinned to the sqs module's default.
process.env.EVAL_MAX_RECEIVES = "3";

// The interview's own clock, pinned to the PRODUCTION shape.
//
// `INTERVIEW_TEST_MODE=true` lives in a developer's `.env` so a real interview
// can be sat through in six minutes instead of forty, and Bun auto-loads it
// here. Left unpinned it silently rewrote the schedule under the test suite:
// `effectiveTargetMinutes` returned 6 on a machine with that line and the
// plan's own 20 in CI, so the `ready` event, the nudge timetable and every
// phase boundary differed by machine. That is the same class of leak the block
// above exists for, reached through a variable nobody thought to list.
//
// Blank rather than "false": `config.interviewTestMode` tests for the string
// "true", so anything else is off — and blank cannot be misread as enabling it.
process.env.INTERVIEW_TEST_MODE = "";
process.env.INTERVIEW_TEST_TARGET_MINUTES = "6";

// Admin surface and observability. Pinned for the same reason everything above
// is: `lib/config.ts` reads all four, so an unpinned one is inherited from a
// developer's `.env` and the suite describes a different world per machine. The
// rule from the INTERVIEW_TEST_MODE leak is that setup.ts names EVERY variable
// config.ts reads, not only the ones that throw when missing.
process.env.APP_ENV = "test";
process.env.ADMIN_GROUP_NAME = "admins";
process.env.ADMIN_USER_PAGE_SIZE = "60";
process.env.METRICS_NAMESPACE = "PrepPilot/Test";

// Emission OFF for the whole suite.
//
// Not a correctness concern — EMF is stdout and nothing reads it here — but the
// route suites drive real Express servers over hundreds of requests, and each one
// would print a JSON metric line. That buries the actual test output and makes a
// failure genuinely hard to find. Tests that care about the emitter assert on it
// directly rather than by reading stdout.
process.env.METRICS_ENABLED = "false";

// Spend controls. Pinned like everything else config.ts reads. The in-memory
// store keeps route tests from sending a DynamoDB write per request.
process.env.RATE_LIMIT_STORE = "memory";
// Blank, so the non-production default applies regardless of a developer's .env.
process.env.CORS_ORIGIN = "";
process.env.MODEL_CALLS_PER_DAY = "40";
process.env.AGENT_RUNS_PER_SESSION = "8";

// Nonsense credentials, deliberately. The SDK resolves lazily, so an unmocked
// command would otherwise pick up the machine's real profile or hang on IMDS in
// CI. These make such a call fail fast and locally rather than reach AWS.
process.env.AWS_ACCESS_KEY_ID = "testaccesskeyid";
process.env.AWS_SECRET_ACCESS_KEY = "testsecretaccesskey";
process.env.AWS_SESSION_TOKEN = "testsessiontoken";
// Belt and braces: stops the SDK falling back to a shared credentials file or
// an SSO profile that happens to be logged in.
process.env.AWS_PROFILE = "";
process.env.AWS_EC2_METADATA_DISABLED = "true";
