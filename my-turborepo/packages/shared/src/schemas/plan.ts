import z from "zod";
import { PreInterviewRepo } from "./preInterview";

// Bounds shared by the schema and the Planner's prompt, so the numbers the model
// is told to respect are the same ones its output is validated against. Drifting
// these apart produces generations that fail validation for no visible reason.
export const PLAN_LIMITS = {
  MIN_FOCUS_AREAS: 2,
  MAX_FOCUS_AREAS: 6,
  // Total questions across both categories — an interview round, not a syllabus.
  MIN_QUESTIONS: 4,
  MAX_QUESTIONS: 20,
  MAX_RESUME_CHARS: 20_000,
  MAX_REPOS: 100,
} as const;

// Seniority the interview should be pitched at. Inferred by the Planner from the
// candidate's material rather than self-reported, so a modest resume does not
// get an easy interview by default.
export const InterviewDifficultySchema = z.enum(["junior", "mid", "senior"]);

export type InterviewDifficulty = z.infer<typeof InterviewDifficultySchema>;

// Everything the Planner needs about the candidate. `resumeText` is optional
// because PDF parsing (`unpdf`) is not wired yet — a plan built from GitHub
// alone is worse but valid, and making it required would block the endpoint on
// unfinished work.
export const PlanRequestSchema = z.object({
  targetRole: z.string().min(1).max(200),
  resumeText: z.string().max(PLAN_LIMITS.MAX_RESUME_CHARS).optional(),
  repos: z.array(PreInterviewRepo).max(PLAN_LIMITS.MAX_REPOS).default([]),
});

export type PlanRequest = z.infer<typeof PlanRequestSchema>;

// The interview plan itself: what to probe, how the round is split, and how hard
// to pitch it. This is also the shape the model must emit, so it is validated
// directly against the generation — no parallel "model output" schema to drift.
export const PlanResponseSchema = z.object({
  // Drawn from the candidate's actual repositories and stated skills, not from
  // generic role expectations.
  focusAreas: z
    .array(z.string().min(1))
    .min(PLAN_LIMITS.MIN_FOCUS_AREAS)
    .max(PLAN_LIMITS.MAX_FOCUS_AREAS),
  questionMix: z.object({
    behavioural: z.number().int().min(0).max(PLAN_LIMITS.MAX_QUESTIONS),
    technical: z.number().int().min(0).max(PLAN_LIMITS.MAX_QUESTIONS),
  }),
  difficulty: InterviewDifficultySchema,
  reasoning: z.string().min(1),
})
  // A mix of 0/0 satisfies both field bounds and still describes no interview.
  // Checking the total is what makes the plan actually runnable.
  .refine(
    (plan) => {
      const total = plan.questionMix.behavioural + plan.questionMix.technical;
      return total >= PLAN_LIMITS.MIN_QUESTIONS && total <= PLAN_LIMITS.MAX_QUESTIONS;
    },
    {
      message: `questionMix must total between ${PLAN_LIMITS.MIN_QUESTIONS} and ${PLAN_LIMITS.MAX_QUESTIONS} questions.`,
      path: ["questionMix"],
    }
  );

export type PlanResponse = z.infer<typeof PlanResponseSchema>;
