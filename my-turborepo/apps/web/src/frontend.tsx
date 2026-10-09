/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { config as configureZod } from "zod";
import { clearLegacyAuthStorage } from "./lib/legacyAuthCleanup";

// Before anything parses. Zod v4 probes `new Function("")` to decide whether to
// JIT-compile its validators. The production Content-Security-Policy has no
// 'unsafe-eval' (infra/terraform/modules/cloudfront), so the probe would fail
// into Zod's own fallback and log a CSP violation on every page load. Jitless
// is that same fallback, chosen up front.
configureZod({ jitless: true });

// No auth library to configure: sign-in goes through the API, which keeps the
// session in httpOnly cookies (ADR-0011). See lib/authApi.ts. What the old
// Amplify client left in localStorage is cleared on the way in.
clearLegacyAuthStorage();

const elem = document.getElementById("root");
if (!elem) {
  throw new Error("Root element #root was not found in index.html");
}

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
(import.meta.hot.data.root ??= createRoot(elem)).render(app);
