import z from "zod";
import { InterviewDifficultySchema } from "./plan";
import { QuestionTypeSchema, SessionEvaluationSchema } from "./session";

// What the Evaluator agent consumes and what it emits. Separate from the stored
// item in session.ts for the same reason PlannerInput is separate from
// PlanRequest: the agent takes one answer and returns scores for it, and knows
// nothing about sessions, queues or who is authenticated.

export const EVALUATION_LIMITS = {
  MIN_SCORE: 0,
  MAX_SCORE: 10,
  // The rationale is shown to the candidate as coaching, so it has to say
  // something. A cap keeps one verbose generation from dominating an item that
  // sits alongside fourteen others.
  MAX_RATIONALE_CHARS: 600,
  // Answers are spoken and already capped by the interview's own clock. This
  // bound exists so a runaway transcript cannot blow the prompt budget.
  MAX_TRANSCRIPT_CHARS: 6_000,
  MAX_QUESTION_CHARS: 1_000,
} as const;

// Derived from the stored item rather than redeclared, so the model is
// validated against exactly the fields that will be persisted. A parallel
// "model output" schema is how the two drift — the Planner avoids the same trap
// by validating directly against PlanResponseSchema.
//
// The remaining attributes on the stored item — questionId, modelId,
// evaluatedAt — are the server's to set. A model that could supply its own
// questionId could write its scores onto a different question's answer.
export const EvaluationScoresSchema = SessionEvaluationSchema.pick({
  correctness: true,
  clarity: true,
  depth: true,
  rationale: true,
});

export type EvaluationScores = z.infer<typeof EvaluationScoresSchema>;

// One exchange, plus the context needed to judge it fairly.
export const EvaluatorInputSchema = z.object({
  questionText: z.string().min(1).max(EVALUATION_LIMITS.MAX_QUESTION_CHARS),
  questionType: QuestionTypeSchema,
  // Deliberately allowed to be empty. A candidate who said nothing is a real
  // outcome and scoring it zero is the honest answer, not an error.
  transcript: z.string().max(EVALUATION_LIMITS.MAX_TRANSCRIPT_CHARS),
  // Barge-in. An answer given over a half-delivered question is not comparable
  // to one given after the whole question, so the Evaluator is told which it is
  // looking at rather than silently penalising the candidate for the difference.
  interrupted: z.boolean(),
  // Pacing signal. Combined with transcript length it distinguishes a terse,
  // confident answer from one that trailed off — and it is available without
  // storing a byte of audio.
  durationMs: z.number().int().min(0),
  targetRole: z.string().min(1).max(200),
  // The interview's opening difficulty, as context for calibration. NOT a
  // multiplier: the interviewer moves off this as the conversation goes, so a
  // late question may be well above or below it. It tells the Evaluator roughly
  // who it is reading, not how hard to mark.
  startingDifficulty: InterviewDifficultySchema,
});

export type EvaluatorInput = z.infer<typeof EvaluatorInputSchema>;
