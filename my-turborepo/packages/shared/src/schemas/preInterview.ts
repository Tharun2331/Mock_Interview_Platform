import z from "zod";

// Upload rules shared by the browser and the server. The client rejects at the
// boundary using these so a too-large file is refused before it is sent, and the
// server enforces the same numbers because a client check is a courtesy, not a
// control. One definition means the two can never disagree about the limit named
// in the error message.
export const RESUME_LIMITS = {
  MAX_BYTES: 8 * 1024 * 1024,
  MIME: "application/pdf",
  EXTENSION: ".pdf",
  // Below this a parse is a scanned or image-only PDF: a result to report to the
  // candidate, not an error to reject.
  MIN_USEFUL_CHARS: 200,
} as const;

export const formatMegabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// Multipart part names. Shared because they are a wire contract: the browser
// writes them and the server reads them, and a rename on one side would fail
// silently as "no resume was included" rather than as a build error.
export const UPLOAD_FIELDS = {
  GITHUB: "gitHub",
  RESUME: "resume",
} as const;

// GitHub's own rule: alphanumerics and single hyphens, no leading or trailing
// hyphen, 39 characters max. Used as a strict allowlist — anything percent
// encoded (`%2e%2e`) or path-like (`a/b`) fails it, which is what keeps a
// user-controlled value out of the upstream request path.
export const GITHUB_USERNAME_REGEX =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

// Returns the profile owner for a GitHub URL, or null if the input is not a
// GitHub profile URL. Parsing with `URL` rather than splitting on "/" is what
// rejects inputs like `https://evil.com/Tharun2331` and
// `https://github.com@evil.com`, which a `.split("/").pop()` accepts.
export function extractGithubUsername(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;

  // A profile URL has exactly one path segment; `/user/repo` is not a profile.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;

  const username = segments[0];
  if (username === undefined) return null;

  return GITHUB_USERNAME_REGEX.test(username) ? username : null;
}

// The GitHub profile is optional: the resume is the required input now, and a
// candidate with no public repositories should not be blocked from starting.
//
// A blank form field arrives as "" rather than absent, so it is folded to
// undefined before validation — otherwise an untouched input would fail the URL
// refinement and read as an error the candidate caused.
export const PreInterviewBody = z.object({
  gitHub: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0 ? undefined : value,
    z
      .string()
      .max(200, "That URL is too long to be a GitHub profile.")
      .refine((value) => extractGithubUsername(value) !== null, {
        message:
          "Enter a GitHub profile URL, like https://github.com/your-username.",
      })
      .optional()
  ),
});

export type PreInterviewBody = z.infer<typeof PreInterviewBody>;

// Response wire shape for POST /api/v1/pre-interview. Mirrors the camelCase
// projection the route builds from GitHub's snake_case payload, so the client
// parses the same contract the server promises instead of trusting the body.
export const PreInterviewRepo = z.object({
  description: z.string().nullable(),
  name: z.string(),
  fullName: z.string(),
  starCount: z.number(),
});

export type PreInterviewRepo = z.infer<typeof PreInterviewRepo>;

// `text` is returned to the client so it can be handed to POST /plan as
// `resumeText` — the same way repos are carried today. Once DynamoDB lands both
// move server-side and this shrinks to a session reference.
export const PreInterviewResume = z.object({
  characters: z.number().int().min(0),
  pages: z.number().int().min(0),
  text: z.string(),
  // False when the PDF parsed but yielded almost nothing — a scanned or
  // image-only resume. Still a result rather than an error: the candidate is
  // shown what was extracted and decides whether to continue or re-upload.
  usable: z.boolean(),
});

export type PreInterviewResume = z.infer<typeof PreInterviewResume>;

export const PreInterviewResponse = z.object({
  // Generated per request. Becomes the DynamoDB session key later; for now it
  // is what ties the stored S3 object to this submission.
  sessionId: z.string().min(1),
  // Empty when no GitHub profile was given, or when the profile has no public
  // repositories. Absence of repos is normal now, not a failure.
  repos: z.array(PreInterviewRepo),
  // Always present — the resume is the required input.
  resume: PreInterviewResume,
});

export type PreInterviewResponse = z.infer<typeof PreInterviewResponse>;
