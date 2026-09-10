// Preloaded by bunfig.toml before any test module is imported.
//
// lib/config.ts is the single process.env boundary and it reads at module
// scope, throwing on a missing COGNITO_* pair. Every route imports it
// transitively, so without this no route test can even load its subject.
//
// The values are deliberately obvious fakes. Nothing here reaches AWS — the
// SDK clients are intercepted by aws-sdk-client-mock — but a test that somehow
// escaped the mock should fail against a nonsense table, not a real one.
process.env.COGNITO_USER_POOL_ID ??= "us-east-1_test000000";
process.env.COGNITO_USER_POOL_CLIENT_ID ??= "testclientid0000000000000";
process.env.SESSIONS_TABLE ??= "prepilot-sessions-test";
process.env.UPLOADS_BUCKET ??= "prepilot-uploads-test";
process.env.AWS_REGION ??= "us-east-1";

// The SDK resolves credentials lazily, but an unmocked command would otherwise
// try the real provider chain and hang on IMDS in CI. Static nonsense fails
// fast instead.
process.env.AWS_ACCESS_KEY_ID ??= "testaccesskeyid";
process.env.AWS_SECRET_ACCESS_KEY ??= "testsecretaccesskey";
