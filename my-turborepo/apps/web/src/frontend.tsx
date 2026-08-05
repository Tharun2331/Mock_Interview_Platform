/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Amplify } from "aws-amplify";
import { App } from "./App";
import { COGNITO } from "./lib/config";

// Configure Amplify once, at startup. This drives the custom email/password
// sign-up + sign-in flow AND the Google hosted-UI redirect flow in the client
// (Cognito stays out of the data path).
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: COGNITO.userPoolId || "",
      userPoolClientId: COGNITO.userPoolClientId || "",
      loginWith: {
        oauth: {
          domain: COGNITO.oauth.domain,
          scopes: [...COGNITO.oauth.scopes],
          redirectSignIn: [...COGNITO.oauth.redirectSignIn],
          redirectSignOut: [...COGNITO.oauth.redirectSignOut],
          responseType: COGNITO.oauth.responseType,
        },
      },
    },
  },
});

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
