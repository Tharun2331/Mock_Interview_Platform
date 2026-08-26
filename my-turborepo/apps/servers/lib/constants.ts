// Tuning values for Bedrock calls. Kept out of the agents so the numbers are
// reviewable in one place rather than scattered through prompt code.
export const BEDROCK = {
  // A plan is a handful of focus areas plus a sentence or two. Capping this
  // matters: output tokens are the expensive half of Bedrock pricing, and an
  // unbounded limit lets a rambling model quietly multiply per-request cost.
  //
  // Raised from 512 when focus areas grew from bare strings to
  // `{area, evidence, source}` and `roleSpecific`/`targetMinutes` landed. Six
  // areas with real evidence lines no longer fit in 512, and a plan truncated
  // mid-JSON fails validation and costs the full generation anyway.
  MAX_TOKENS: 768,
  // Lowered from 0.3 alongside the schema change. Structured JSON from an 8B
  // model gains more from determinism than the plan gains from variety, and
  // the few-shot exemplar now supplies the shape that temperature used to
  // have to guess at.
  TEMPERATURE: 0.2,
} as const;

// Tool names the Mock Interview agent calls over the Sonic stream. Referenced
// by both the system prompt and the tool specs, and later by the dispatcher on
// the WebSocket side, so a rename cannot desync the prompt from the handler.
export const INTERVIEW_TOOL_NAMES = {
  LOG_EXCHANGE: "logExchange",
  GET_SESSION_STATE: "getSessionState",
  END_INTERVIEW: "endInterview",
} as const;

// Pacing bounds for the live interview. These are prompt guidance, not
// enforcement — nothing can stop a spoken conversation mid-sentence — but they
// keep the interviewer from either abandoning a topic after one answer or
// grinding on it until the clock runs out.
export const INTERVIEW = {
  MIN_EXCHANGES_PER_AREA: 2,
  MAX_EXCHANGES_PER_AREA: 4,
} as const;

import { RESUME_LIMITS, UPLOAD_FIELDS } from "@repo/shared";

export const UPLOAD = {
  RESUME_FIELD: UPLOAD_FIELDS.RESUME,
  GITHUB_FIELD: UPLOAD_FIELDS.GITHUB,
  // Sourced from @repo/shared so the browser rejects at exactly the limit the
  // server enforces — and both quote the same number back to the user.
  MAX_RESUME_BYTES: RESUME_LIMITS.MAX_BYTES,
  RESUME_MIME: RESUME_LIMITS.MIME,
  // Multipart framing — boundaries, part headers, the sibling text field — sits
  // on top of the file itself, so the whole-body budget has to be a little
  // larger than the per-file limit or a file exactly at the cap is refused.
  BODY_OVERHEAD_BYTES: 8 * 1024,
  // Every PDF starts with this. The `type` on an uploaded File is whatever the
  // client claimed, so the header is the only trustworthy signal.
  PDF_MAGIC: "%PDF-",
  MIN_USEFUL_RESUME_CHARS: RESUME_LIMITS.MIN_USEFUL_CHARS,
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
