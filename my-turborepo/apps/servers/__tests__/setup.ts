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
process.env.SESSIONS_TABLE = "prepilot-sessions-test";
process.env.UPLOADS_BUCKET = "prepilot-uploads-test";
process.env.AWS_REGION = "us-east-1";

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
