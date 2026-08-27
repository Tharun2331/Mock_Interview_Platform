export const MESSAGES = {
  INVALID_BODY:         "Invalid request body",
  MISSING_GITHUB_USER:  "Could not extract GitHub username from URL",
  GITHUB_FETCH_FAILED:  "Failed to fetch GitHub repos",
  INVALID_PLAN_BODY:    "Invalid request body",
  UNAUTHORIZED_MISSING_TOKEN: "Unauthorized: missing or malformed token",
  UNAUTHORIZED_INVALID_TOKEN: "Unauthorized: invalid token",
  RATE_LIMITED:         "Too many requests. Wait a moment and try again.",
  PLAN_FAILED:          "Could not generate an interview plan. Try again.",

  UPLOAD_NOT_A_FILE:    "No resume file was included in the upload.",
  RESUME_REQUIRED:      "A resume PDF is required to start an interview.",
  EXPECTED_MULTIPART:   "Send this request as multipart/form-data with a resume file.",
  UPLOAD_NOT_PDF:       "That file is not a PDF. Upload your resume as a PDF.",
  UPLOAD_MALFORMED:     "The upload could not be read. Try selecting the file again.",
  // Log-facing: names the fix for whoever is reading server output.
  UPLOAD_BUCKET_UNSET:  "UPLOADS_BUCKET is not set. Run `terraform output uploads_bucket_id` and set it in apps/servers/.env.",
  SESSIONS_TABLE_UNSET: "SESSIONS_TABLE is not set. Run `terraform output sessions_table_name` and set it in apps/servers/.env.",
  // Both log-facing. A stored item that no longer matches its schema is a
  // deploy-skew bug, not something a candidate can act on — the client sees the
  // route's generic failure copy instead.
  SESSION_ITEM_MISSING: "Expected a session item that was not present.",
  SESSION_ITEM_INVALID: "A stored session item did not match its schema.",
  SESSION_CREATE_FAILED: "Could not create the interview session.",
  SESSION_UPDATE_FAILED: "Could not update the interview session.",
  SESSION_READ_FAILED:   "Could not read the interview session.",
  // Client-facing. Re-planning after the interview starts would change the
  // focus areas and question count out from under answers already recorded.
  SESSION_ALREADY_STARTED: "This interview has already started, so its plan can no longer be changed.",
  // Client-facing. Covers both "no such session" and "not yours" — see
  // SessionAccessError for why those are not distinguished.
  SESSION_NOT_FOUND:    "That interview session could not be found.",
  // Client-facing counterpart to SESSION_CREATE_FAILED. The candidate's resume
  // uploaded fine; the record of it did not save.
  SESSION_UNAVAILABLE:  "We could not start your session right now. This is on our side — try again shortly.",
  // The genuine catch-all. Says nothing about what the candidate sent, because
  // by definition we do not know — anything that named a specific cause here
  // would be a guess, and the last one sent people to re-check a valid URL.
  UNEXPECTED_FAILED:    "Something went wrong on our side. Try again shortly.",
  // Client-facing counterpart. Says it is our problem, not their file's.
  UPLOAD_UNAVAILABLE:   "We could not store your resume right now. This is on our side — try again shortly, or continue without it.",
  UPLOAD_STORE_FAILED:  "Could not store the resume. Try again.",
  RESUME_PARSE_FAILED:  "That PDF could not be read. It may be corrupt or password-protected.",
} as const;

// States the limit in the same breath as the violation, so the user knows what
// to do rather than just that something was wrong.
export const uploadTooLarge = (actualBytes: number, maxBytes: number): string => {
  const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  return `That file is ${mb(actualBytes)} MB. The limit is ${mb(maxBytes)} MB.`;
};
