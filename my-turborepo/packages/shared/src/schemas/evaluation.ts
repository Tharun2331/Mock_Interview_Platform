import z from "zod";
import { InterviewDifficultySchema } from "./plan";
import {
  ITEM_TYPE,
  QuestionTypeSchema,
  SessionEvaluationSchema,
} from "./session";

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

// One SQS message on the eval queue: a pointer, not a payload.
//
// Deliberately carries no transcript. Three reasons, in order of weight:
//
// 1. The transcript is the candidate speaking about themselves. Copying it into
//    a second store widens the blast radius of an account erasure — the sweep
//    can delete DynamoDB items and S3 objects, but it cannot reach into a
//    queue. A pointer to a deleted item resolves to nothing, which is the
//    correct outcome. ADR-0007's reasoning applied one layer out.
// 2. The worker reads the answer at the moment it scores it, so the message can
//    never carry a stale copy of text that was corrected or removed.
// 3. It keeps every message far inside SQS's 256 KB limit regardless of how
//    long an answer ran.
//
// The cost is one DynamoDB read per message, which is the same read the
// worker's duplicate-check needs anyway.
export const EvalJobSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
});

export type EvalJob = z.infer<typeof EvalJobSchema>;

// One scored answer, as a candidate reads it.
//
// Deliberately NOT the stored item. `modelId` is on every EVAL# row and must
// not appear here: which model scored an answer is an operational detail, and
// the frontend contract is that a candidate is talking to "the interviewer",
// never to a named service. Exposing it would also invite comparing scores
// across models, which is exactly the comparison the attribute exists to warn
// engineers about.
export const EvaluationViewSchema = z.object({
  questionId: z.string().min(1),
  questionText: z.string(),
  questionType: QuestionTypeSchema,
  // Their own words, returned so the score has something to sit against. A
  // rating with no visible answer is unreadable as feedback.
  transcript: z.string(),
  // Shown in the detail view: a score on a half-heard question needs its
  // context, or it reads as an unexplained penalty.
  interrupted: z.boolean(),
  durationMs: z.number().int().min(0),
  correctness: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
  clarity: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
  depth: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
  rationale: z.string().min(1),
  evaluatedAt: z.iso.datetime(),
});

export type EvaluationView = z.infer<typeof EvaluationViewSchema>;

// GET /api/v1/sessions/:sessionId/evaluation
//
// A poll target, not a one-shot read. Scoring is asynchronous, so this returns
// whatever has landed rather than waiting for all of it — a candidate can read
// the first three scores while the rest are still queued, which is the whole
// point of having done the work asynchronously.
export const EvaluationResponseSchema = z.object({
  // `evaluating` while the queue drains, `complete` once every answer is
  // scored. The client polls on the former and stops on the latter.
  status: z.enum(["evaluating", "complete", "failed"]),
  // Scored so far, and the number expected. `total` is the answers actually
  // enqueued — an interview stopped early by the hard timer has fewer answers
  // than its plan called for, and showing the planned number would leave a
  // finished session reading as permanently incomplete.
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  // Absent until every answer is scored. Its presence is what tells the client
  // the round is genuinely finished, and it is written by the same conditional
  // update that completes the session.
  averages: z
    .object({
      correctness: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
      clarity: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
      depth: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
    })
    .optional(),
  // Ordered as they were asked. ULIDs sort lexicographically by creation time,
  // so the natural key order is already the interview's order.
  evaluations: z.array(EvaluationViewSchema),
  role: z.string().optional(),
});

export type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

// Which of the three dimensions a session was strongest and weakest at.
export const ScoreDimensionSchema = z.enum(["correctness", "clarity", "depth"]);

export type ScoreDimension = z.infer<typeof ScoreDimensionSchema>;

// USER#<uid> / SUMMARY#<completedAt> — one row per finished interview.
//
// Deliberately small. The history page lists every interview a candidate has
// ever done, and the alternative — reading each session's META plus its
// evaluations to build that list — is N queries that grow with a candidate's
// history and pull transcripts nobody is looking at. This is one Query
// returning one small row per session.
//
// What is NOT here, and must not be added: transcripts, per-question scores,
// rationales, coach tips. Those live on the session's own items and are fetched
// by the detail view when a card is actually clicked. Copying them here would
// make every history page load pay for data that is read once in twenty.
export const UserSessionSummarySchema = z.object({
  type: z
    .literal(ITEM_TYPE.USER_SESSION_SUMMARY)
    .default(ITEM_TYPE.USER_SESSION_SUMMARY),
  // Carried for the same reason UserSessionRef carries one: this row points at
  // a session whose items expire, and without it the history page would list an
  // interview whose every item is gone. Copied from the session's META rather
  // than recomputed, so the card and the session it describes expire together.
  expiresAt: z.number().int().positive().optional(),
  sessionId: z.string().min(1),
  // Also the sort key's suffix. Stored as an attribute too so a reader does not
  // have to parse it back out of the key.
  completedAt: z.iso.datetime(),
  role: z.string().min(1).optional(),
  // The mean of the three dimension averages. One number for the trend chart,
  // which is the only thing on the history page that needs a single score.
  overallScore: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
  topStrength: ScoreDimensionSchema,
  topWeakness: ScoreDimensionSchema,
  questionCount: z.number().int().min(0),
});

export type UserSessionSummary = z.infer<typeof UserSessionSummarySchema>;

// GET /api/v1/sessions/history
export const SessionHistoryItemSchema = UserSessionSummarySchema.pick({
  sessionId: true,
  completedAt: true,
  role: true,
  overallScore: true,
  topStrength: true,
  topWeakness: true,
  questionCount: true,
});

export type SessionHistoryItem = z.infer<typeof SessionHistoryItemSchema>;

export const SessionHistoryResponseSchema = z.object({
  // Newest first, which is what the card list wants. The trend chart reverses
  // it — a line running right-to-left in time would read as improvement when it
  // is decline.
  sessions: z.array(SessionHistoryItemSchema),
});

export type SessionHistoryResponse = z.infer<typeof SessionHistoryResponseSchema>;

// Which dimension was strongest and weakest across a session.
//
// Ties resolve by a fixed order rather than arbitrarily, and the order matters
// for one specific case: a perfectly flat profile. Picking max and min
// independently would then name the SAME dimension as both strength and
// weakness, which reads as a bug. Sorting once and taking the ends cannot.
const DIMENSION_ORDER: readonly ScoreDimension[] = [
  "correctness",
  "clarity",
  "depth",
];

export function extremeDimensions(averages: {
  correctness: number;
  clarity: number;
  depth: number;
}): { topStrength: ScoreDimension; topWeakness: ScoreDimension } {
  const ranked = [...DIMENSION_ORDER].sort(
    (a, b) => averages[b] - averages[a]
  );

  // `ranked` always has three entries, but the compiler cannot know that from
  // an array type — and a non-null assertion is not allowed here.
  const [best] = ranked;
  const worst = ranked[ranked.length - 1];

  return {
    topStrength: best ?? "correctness",
    topWeakness: worst ?? "depth",
  };
}

export function overallScore(averages: {
  correctness: number;
  clarity: number;
  depth: number;
}): number {
  const mean =
    (averages.correctness + averages.clarity + averages.depth) / 3;
  // One decimal, matching how the per-dimension averages are already rounded.
  return Math.round(mean * 10) / 10;
}
