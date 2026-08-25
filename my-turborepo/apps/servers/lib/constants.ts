// Tuning values for Bedrock calls. Kept out of the agents so the numbers are
// reviewable in one place rather than scattered through prompt code.
export const BEDROCK = {
  // A plan is a handful of focus areas plus a sentence or two. Capping this
  // matters: output tokens are the expensive half of Bedrock pricing, and an
  // unbounded limit lets a rambling model quietly multiply per-request cost.
  MAX_TOKENS: 512,
  // Low but not zero. The plan should be stable for a given candidate, while
  // still varying enough that two runs don't read as canned.
  TEMPERATURE: 0.3,
} as const;

export const UPLOAD = {
  RESUME_FIELD: "resume",
  GITHUB_FIELD: "gitHub",
  // Two pages of PDF is well under 1 MB; 8 MB tolerates a design-heavy resume
  // with embedded fonts. The bridge buffers the file in memory, so this is a
  // memory bound, not just a politeness limit.
  MAX_RESUME_BYTES: 8 * 1024 * 1024,
  RESUME_MIME: "application/pdf",
  // Multipart framing — boundaries, part headers, the sibling text field — sits
  // on top of the file itself, so the whole-body budget has to be a little
  // larger than the per-file limit or a file exactly at the cap is refused.
  BODY_OVERHEAD_BYTES: 8 * 1024,
  // Every PDF starts with this. The `type` on an uploaded File is whatever the
  // client claimed, so the header is the only trustworthy signal.
  PDF_MAGIC: "%PDF-",
  // A parse yielding less than this is a scan or an image-only PDF — a result
  // to report, not an error to throw.
  MIN_USEFUL_RESUME_CHARS: 200,
} as const;

// How much candidate material goes into the prompt. These are cost and
// relevance controls, not correctness ones — the plan is only as good as the
// signal here, but every extra character is an input token on every request.
//
// Validation bounds for the plan itself live in `PLAN_LIMITS` in
// `@repo/shared`, so the schema and the prompt cannot disagree.
export const PROMPT = {
  // Repos are sent highest-starred first; the long tail of forks and
  // scratch projects says little about what a candidate can be asked.
  MAX_REPOS: 15,
  MAX_REPO_DESCRIPTION_CHARS: 160,
  // Enough for a two-page resume. Truncation is preferred over rejection:
  // a plan from a partial resume beats no plan at all.
  MAX_RESUME_CHARS: 4_000,
} as const;
