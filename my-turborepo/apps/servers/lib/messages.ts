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
  UPLOAD_NOT_PDF:       "That file is not a PDF. Upload your resume as a PDF.",
  UPLOAD_MALFORMED:     "The upload could not be read. Try selecting the file again.",
  UPLOAD_BUCKET_UNSET:  "Resume storage is not configured on this server.",
  UPLOAD_STORE_FAILED:  "Could not store the resume. Try again.",
  RESUME_PARSE_FAILED:  "That PDF could not be read. It may be corrupt or password-protected.",
} as const;

// States the limit in the same breath as the violation, so the user knows what
// to do rather than just that something was wrong.
export const uploadTooLarge = (actualBytes: number, maxBytes: number): string => {
  const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
  return `That file is ${mb(actualBytes)} MB. The limit is ${mb(maxBytes)} MB.`;
};
