import z from "zod";
import { ITEM_TYPE } from "./session";

// What the candidate's material does and does not cover against a specific job
// description. Consumed by the Mock Interview agent as a question budget.

export const GAP_LIMITS = {
  // Capped to control token spend: the evidence note for each requirement is
  // generated text, so the output grows linearly with this number.
  MAX_REQUIREMENTS: 12,
  // Long enough for "three years of React at EY", short enough that the model
  // cannot pad it into a paragraph.
  MAX_EVIDENCE_CHARS: 160,
  MAX_REQUIREMENT_CHARS: 200,
  // A job description is a page, not a book. Truncated rather than rejected:
  // the top of a posting carries the requirements, so a cut tail loses little.
  MAX_JOB_DESCRIPTION_CHARS: 8_000,
} as const;

// Exactly one per requirement. The three are exhaustive by construction — an
// enum rather than three booleans, so "strong and none" is unrepresentable
// rather than merely unlikely.
export const RequirementBucketSchema = z.enum(["strong", "weak", "none"]);

export type RequirementBucket = z.infer<typeof RequirementBucketSchema>;

export const GapRequirementSchema = z.object({
  requirement: z.string().min(1).max(GAP_LIMITS.MAX_REQUIREMENT_CHARS),
  bucket: RequirementBucketSchema,
  // What backed the call, or what was missing. Required even for "none",
  // because "no evidence found" is the most useful note of the three — it is
  // what the interview is going to probe.
  evidence: z.string().min(1).max(GAP_LIMITS.MAX_EVIDENCE_CHARS),
});

export type GapRequirement = z.infer<typeof GapRequirementSchema>;

// SESSION#<sid> / GAP
//
// Stored so an interview can be resumed, or its stream renewed, without paying
// for the analysis again — the Mock Interview agent reads this back on every
// stream, and a renewal happens roughly every six minutes.
export const GapAnalysisSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_GAP).default(ITEM_TYPE.SESSION_GAP),
  expiresAt: z.number().int().positive().optional(),
  sessionId: z.string().min(1),
  requirements: z.array(GapRequirementSchema).max(GAP_LIMITS.MAX_REQUIREMENTS),
  createdAt: z.iso.datetime(),
});

export type GapAnalysis = z.infer<typeof GapAnalysisSchema>;

// Just the requirement list, which is what the model is asked to produce.
// sessionId and createdAt are the server's to set — a model that could supply
// its own sessionId could write an analysis onto a different interview.
export const GapRequirementsSchema = z.object({
  requirements: z.array(GapRequirementSchema).max(GAP_LIMITS.MAX_REQUIREMENTS),
});

export type GapRequirements = z.infer<typeof GapRequirementsSchema>;

// Splits a requirement list into what the interview should probe and what it
// should confirm.
//
// Shared rather than derived at the call site so the Mock Interview agent's
// prompt and any test of it cannot disagree about which bucket is which.
export function gapQuestionTargets(analysis: GapAnalysis): {
  probe: GapRequirement[];
  confirm: GapRequirement[];
} {
  return {
    // "none" first: a requirement with no evidence is the most valuable thing
    // to ask about, and the ordering survives into the prompt.
    probe: [
      ...analysis.requirements.filter((item) => item.bucket === "none"),
      ...analysis.requirements.filter((item) => item.bucket === "weak"),
    ],
    confirm: analysis.requirements.filter((item) => item.bucket === "strong"),
  };
}
