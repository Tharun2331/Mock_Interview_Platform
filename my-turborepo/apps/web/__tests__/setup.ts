import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Preloaded by bunfig.toml. happy-dom rather than jsdom: it is markedly faster
// and everything these tests touch (rendering, events, the DOM Testing Library
// queries) is well covered by it.
GlobalRegistrator.register();

// The build inlines these, and lib/config.ts throws on any that is absent —
// deliberately, so a misconfigured deploy cannot boot. Anything importing
// lib/config transitively (which is most of the app) needs them set first.
// These three are the whole list `requirePublicEnv` guards; the OAuth domain
// and redirect URLs are literals in that file, not environment variables.
process.env.BUN_PUBLIC_REGION ??= "us-east-1";
process.env.BUN_PUBLIC_COGNITO_USER_POOL_ID ??= "us-east-1_test000000";
process.env.BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID ??= "testclientid000000000000";
