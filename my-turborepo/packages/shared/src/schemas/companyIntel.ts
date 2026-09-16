import { z } from "zod";
import { ITEM_TYPE } from "./session";

// What the interview can learn about the company it is imitating.
//
// A garnish on the Gap agent, never a replacement. Everything here degrades to
// "unknown", and an all-unknown result is a valid outcome rather than an error
// — thin search results must produce "unknown" rather than an invented answer,
// because a confidently wrong reading of a company's process is worse for a
// candidate than no reading at all.
//
// Scope, deliberately narrow for v1: this shapes the tone and emphasis of
// questions inside the ONE existing interview round. It does not spawn round
// types. A system-design round needs a diagramming surface and a LeetCode round
// needs an execution sandbox; both are v2.

export const INTEL_LIMITS = {
  MAX_COMPANY_CHARS: 120,
  // The user's own note about the process. Generous enough for a recruiter
  // email pasted whole, capped because it reaches both a model and a prompt.
  MAX_NOTES_CHARS: 1_000,
  // Two queries in, and only the cleaned snippets reach the model. Past this
  // the classification is not better, only more expensive.
  MAX_SNIPPETS: 6,
  MAX_SNIPPET_CHARS: 800,
} as const;

// Every enum carries "unknown" as a real member rather than modelling absence
// with null. A nullable enum makes "we could not tell" and "the field was never
// populated" the same value, and only one of those should reach a prompt.
export const InterviewStyleSchema = z.enum([
  "practical",
  "theoretical",
  "mixed",
  "unknown",
]);

export const InterviewFocusSchema = z.enum([
  "product",
  "infrastructure",
  "mixed",
  "unknown",
]);

export const SeniorityLeaningSchema = z.enum([
  "junior",
  "mid",
  "senior",
  "unknown",
]);

export type InterviewStyle = z.infer<typeof InterviewStyleSchema>;
export type InterviewFocus = z.infer<typeof InterviewFocusSchema>;
export type SeniorityLeaning = z.infer<typeof SeniorityLeaningSchema>;

/** What the model is asked to produce: three enum picks, no prose. */
export const CompanyClassificationSchema = z.object({
  style: InterviewStyleSchema,
  focus: InterviewFocusSchema,
  seniority: SeniorityLeaningSchema,
});

export type CompanyClassification = z.infer<typeof CompanyClassificationSchema>;

/** The all-unknown result. Returned whenever search found nothing, the search
 *  call failed, or the model could not classify — one shape for every way of
 *  knowing nothing, so callers need one branch instead of four. */
export const UNKNOWN_CLASSIFICATION: CompanyClassification = {
  style: "unknown",
  focus: "unknown",
  seniority: "unknown",
};

export const CompanyIntelSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_INTEL).default(ITEM_TYPE.SESSION_INTEL),
  expiresAt: z.number().int().positive().optional(),
  sessionId: z.string().min(1),
  company: z.string().min(1).max(INTEL_LIMITS.MAX_COMPANY_CHARS),
  style: InterviewStyleSchema,
  focus: InterviewFocusSchema,
  seniority: SeniorityLeaningSchema,
  // The candidate's own words about the process, carried verbatim rather than
  // classified. This is how "the user wins a conflict" is implemented: the
  // enums are a guess assembled from public pages, and this came from someone
  // who spoke to a recruiter. The prompt states the precedence outright.
  notes: z.string().max(INTEL_LIMITS.MAX_NOTES_CHARS).optional(),
  // How many search snippets the classification was drawn from. Zero means the
  // enums came from the notes alone, or from nothing.
  sourceCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});

export type CompanyIntel = z.infer<typeof CompanyIntelSchema>;

/**
 * True when there is nothing worth putting in a prompt.
 *
 * All three enums unknown AND no note from the candidate. Rendering a section
 * that says "we could not tell you anything about this company" spends tokens
 * to tell the interviewer to ignore it — better to omit the section entirely
 * and let the interview run on the session brief and the gap analysis.
 */
export function intelIsEmpty(intel: CompanyIntel): boolean {
  const noteless = (intel.notes ?? "").trim().length === 0;
  return (
    noteless &&
    intel.style === "unknown" &&
    intel.focus === "unknown" &&
    intel.seniority === "unknown"
  );
}
