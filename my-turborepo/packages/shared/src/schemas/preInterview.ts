import z from "zod";

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

export const PreInterviewBody = z.object({
  gitHub: z
    .string()
    .max(200, "That URL is too long to be a GitHub profile.")
    .refine((value) => extractGithubUsername(value) !== null, {
      message:
        "Enter a GitHub profile URL, like https://github.com/your-username.",
    }),
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

// Present only when a resume was uploaded. `text` is returned to the client so
// it can be handed to POST /plan as `resumeText` — the same way repos are
// carried today. Once DynamoDB lands both move server-side and this shrinks to
// a session reference.
export const PreInterviewResume = z.object({
  characters: z.number().int().min(0),
  pages: z.number().int().min(0),
  text: z.string(),
  // False when the PDF parsed but yielded almost nothing — a scanned or
  // image-only resume. A result to report, not an error: the caller can still
  // proceed on GitHub data alone.
  usable: z.boolean(),
});

export type PreInterviewResume = z.infer<typeof PreInterviewResume>;

export const PreInterviewResponse = z.object({
  // Generated per request. Becomes the DynamoDB session key later; for now it
  // is what ties the stored S3 object to this submission.
  sessionId: z.string().min(1),
  repos: z.array(PreInterviewRepo),
  resume: PreInterviewResume.optional(),
});

export type PreInterviewResponse = z.infer<typeof PreInterviewResponse>;
