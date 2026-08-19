export const MESSAGES = {
  INVALID_BODY:         "Invalid request body",
  MISSING_GITHUB_USER:  "Could not extract GitHub username from URL",
  GITHUB_FETCH_FAILED:  "Failed to fetch GitHub repos",
  INVALID_PLAN_BODY:    "Invalid request body",
  UNAUTHORIZED_MISSING_TOKEN: "Unauthorized: missing or malformed token",
  UNAUTHORIZED_INVALID_TOKEN: "Unauthorized: invalid token",
  RATE_LIMITED:         "Too many requests. Wait a moment and try again.",
  PLAN_FAILED:          "Could not generate an interview plan. Try again.",
} as const;
