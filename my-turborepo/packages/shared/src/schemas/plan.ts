import z from "zod";
import { PreInterviewRepo } from "./preInterview";

// Bounds shared by the schema and the Planner's prompt, so the numbers the model
// is told to respect are the same ones its output is validated against. Drifting
// these apart produces generations that fail validation for no visible reason.
export const PLAN_LIMITS = {
  MIN_FOCUS_AREAS: 2,
  MAX_FOCUS_AREAS: 6,
  // Total questions across all three categories — an interview round, not a
  // syllabus. A budget for the live interviewer, not a script it must finish.
  MIN_QUESTIONS: 4,
  MAX_QUESTIONS: 15,
  MAX_RESUME_CHARS: 20_000,
  MAX_REPOS: 40,
  // Wall-clock budget for the spoken session. The Mock Interview agent paces
  // itself against this, so it has to be a real number rather than an estimate
  // the model invents per plan.
  MIN_TARGET_MINUTES: 15,
  MAX_TARGET_MINUTES: 40,
  // Voice pacing. A spoken answer plus one or two follow-ups runs longer than
  // the same exchange typed, which is what ties question count to minutes.
  MIN_MINUTES_PER_QUESTION: 2,
  MAX_MINUTES_PER_QUESTION: 4,
} as const;

// Seniority the interview *opens* at. Inferred by the Planner from the
// candidate's material rather than self-reported, so a modest resume does not
// get an easy interview by default — and deliberately not a setting applied to
// the whole session. See `startingDifficulty` below.
export const InterviewDifficultySchema = z.enum(["junior", "mid", "senior"]);

export type InterviewDifficulty = z.infer<typeof InterviewDifficultySchema>;

// Which of the candidate's own materials a focus area was drawn from.
export const FocusAreaSourceSchema = z.enum(["github", "resume"]);

export type FocusAreaSource = z.infer<typeof FocusAreaSourceSchema>;

// A focus area carries its own justification rather than being a bare string.
// Two reasons, both load-bearing:
//
// 1. Requiring the model to name the repo or resume line behind each area is
//    what stops it restating the job description back as a "plan".
// 2. The Mock Interview agent opens each area with a question grounded in this
//    evidence, so a question can only be asked of someone who actually built
//    the thing. Without it the interviewer falls back to generic prompts.
export const FocusAreaSchema = z.object({
  area: z.string().min(1),
  evidence: z.string().min(1),
  source: FocusAreaSourceSchema,
});

export type FocusArea = z.infer<typeof FocusAreaSchema>;

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
    .array(FocusAreaSchema)
    .min(PLAN_LIMITS.MIN_FOCUS_AREAS)
    .max(PLAN_LIMITS.MAX_FOCUS_AREAS),
  // A budget the live interviewer spends, not a queue it drains. It exists to
  // stop a session running 40 behavioural questions deep, not to prescribe an
  // order — the Mock Interview agent interleaves the three types as the
  // conversation goes.
  questionMix: z.object({
    behavioural: z.number().int().min(0).max(PLAN_LIMITS.MAX_QUESTIONS),
    technical: z.number().int().min(0).max(PLAN_LIMITS.MAX_QUESTIONS),
    roleSpecific: z.number().int().min(0).max(PLAN_LIMITS.MAX_QUESTIONS),
  }),
  // A hypothesis, not a setting. The Mock Interview agent tests this over the
  // first exchange or two of each focus area and moves off it in either
  // direction based on what it actually hears. Nothing pins the whole session
  // to it — that is the difference between an adaptive interview and a quiz
  // with a difficulty slider.
  startingDifficulty: InterviewDifficultySchema,
  targetMinutes: z
    .number()
    .int()
    .min(PLAN_LIMITS.MIN_TARGET_MINUTES)
    .max(PLAN_LIMITS.MAX_TARGET_MINUTES),
  reasoning: z.string().min(1),
})
  // A mix of all zeroes satisfies every field bound and still describes no
  // interview. Checking the total is what makes the plan actually runnable.
  .refine(
    (plan) => {
      const total =
        plan.questionMix.behavioural +
        plan.questionMix.technical +
        plan.questionMix.roleSpecific;
      return total >= PLAN_LIMITS.MIN_QUESTIONS && total <= PLAN_LIMITS.MAX_QUESTIONS;
    },
    {
      message: `questionMix must total between ${PLAN_LIMITS.MIN_QUESTIONS} and ${PLAN_LIMITS.MAX_QUESTIONS} questions.`,
      path: ["questionMix"],
    }
  );

export type PlanResponse = z.infer<typeof PlanResponseSchema>;
