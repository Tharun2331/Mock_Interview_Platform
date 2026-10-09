import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Preloaded by bunfig.toml. happy-dom rather than jsdom: it is markedly faster
// and everything these tests touch (rendering, events, the DOM Testing Library
// queries) is well covered by it.
GlobalRegistrator.register();

// No Cognito variables to pin any more: the bundle has none (ADR-0011), so
// lib/config.ts throws on nothing at import.
