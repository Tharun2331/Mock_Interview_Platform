import axios from "axios";
import { fetchAuthSession } from "aws-amplify/auth";
import { API_TIMEOUT_MS, BACKEND_URL } from "@/lib/config";

// The single authenticated client for the PrepPilot API. Every route behind the
// server's `AuthMiddleware` requires `Authorization: Bearer <token>`, so the
// header is attached here once rather than remembered at each call site.
export const api = axios.create({
  baseURL: BACKEND_URL,
  timeout: API_TIMEOUT_MS,
});

// Runs per request, not once at startup, because `fetchAuthSession` reads the
// cached tokens and silently refreshes them when they have expired — a session
// that outlives an access token keeps working without a re-login.
//
// The server verifies with `tokenUse: "access"`, so the ACCESS token is the
// required one. Sending the id token here fails verification even though the
// user is properly signed in.
api.interceptors.request.use(async (requestConfig) => {
  const { tokens } = await fetchAuthSession();
  const accessToken = tokens?.accessToken?.toString();

  if (accessToken) {
    requestConfig.headers.set("Authorization", `Bearer ${accessToken}`);
  }

  return requestConfig;
});
