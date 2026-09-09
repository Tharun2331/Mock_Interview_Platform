import z from "zod";
import { PLAN_LIMITS, PlanResponseSchema } from "./plan";
import { PreInterviewRepo } from "./preInterview";

// Item shapes for the single DynamoDB table, specified in
// docs/architecture/data-model.md §1.
//
// These validate in both directions. Validating on the way *out* of DynamoDB
// matters as much as on the way in: an item written by an older deploy may not
// match the current shape, and a parse failure at the storage boundary is a far
// better outcome than an `undefined` surfacing three layers up in the Evaluator.

// The SK discriminators. Kept here rather than in the server's constants.ts
// because the key layout is a contract between whatever writes an item and
// whatever reads it, and those will not always be the same service — the
// Evaluator worker is a separate process in Phase 5.
export const KEY_PREFIX = {
  SESSION: "SESSION#",
  USER: "USER#",
  ANSWER: "ANSWER#",
  EVAL: "EVAL#",
} as const;

// Fixed sort keys, as opposed to the prefixed ones above.
//
// PROFILE and PLAN live under USER#<uid>, not SESSION#<sid>: the candidate's
// resume and repositories are captured once at onboarding and reused by every
// session, so they are user-scoped material rather than session-scoped input.
// PLAN caches the last Planner output so a second interview against the same
// role and the same material does not pay for a second generation.
//
// EVAL_SUMMARY is "SUMMARY", NOT "EVAL#SUMMARY".
//
// It used to be the latter, which put it inside the range that
// `Query ... begins_with("EVAL#")` returns. That query is how completion is
// derived — the Coach fires when the number of EVAL# items reaches
// `questionCount` — so the rollup would have counted as an evaluation and the
// Coach would have fired one question early, on an interview that was still
// being scored. Nothing writes the item yet, so this rename costs nothing now
// and would have cost a Phase 5 debugging session later.
export const SORT_KEY = {
  META: "META",
  INPUTS: "INPUTS",
  COACH: "COACH",
  EVAL_SUMMARY: "SUMMARY",
  PROFILE: "PROFILE",
  PLAN: "PLAN",
} as const;

// A self-describing `type` on every item, independent of its keys.
//
// The keys already imply the type, so this is not how a reader dispatches — SK
// is always present and is the cheaper check. What it buys is the item being
// legible outside this codebase: a PITR export or an S3 dump is a pile of rows
// where PK/SK parsing is the only way to tell a transcript from a profile, and
// anything downstream (analytics, a future migration script, an incident) has
// to reimplement that parsing to read anything.
//
// Written with `.default()` rather than required, deliberately. A required
// literal would reject every item written before this attribute existed —
// validate-on-read turns that into a hard failure on real sessions. The default
// materialises the value for old rows on the way out while new writes carry it
// for real.
//
// Consequence worth knowing: `z.discriminatedUnion` cannot use these yet. Union
// dispatch happens before a member's defaults run, so an item missing `type` is
// rejected outright rather than defaulted. Once every stored item carries the
// attribute, these can become required and the union becomes available.
export const ITEM_TYPE = {
  SESSION_META: "session_meta",
  SESSION_INPUTS: "session_inputs",
  SESSION_ANSWER: "session_answer",
  SESSION_EVALUATION: "session_evaluation",
  SESSION_EVAL_SUMMARY: "session_eval_summary",
  SESSION_COACH: "session_coach",
  USER_SESSION_REF: "user_session_ref",
  USER_PROFILE: "user_profile",
  CACHED_PLAN: "cached_plan",
} as const;

export const sessionPk = (sessionId: string): string =>
  `${KEY_PREFIX.SESSION}${sessionId}`;

export const userPk = (userId: string): string => `${KEY_PREFIX.USER}${userId}`;

export const answerSk = (questionId: string): string =>
  `${KEY_PREFIX.ANSWER}${questionId}`;

export const evalSk = (questionId: string): string =>
  `${KEY_PREFIX.EVAL}${questionId}`;

export const sessionSk = (sessionId: string): string =>
  `${KEY_PREFIX.SESSION}${sessionId}`;

// Unix-epoch seconds for DynamoDB TTL, carried by every session-scoped item.
//
// Optional because items written before retention existed have none, and an
// item without the attribute simply never expires — TTL ignores it rather than
// treating it as already due. That makes adding this safe for existing rows and
// makes it useless for them; only new sessions get an expiry.
//
// Every writer of a session-scoped item must set it. If one forgets, that item
// outlives the session it belongs to and becomes an orphan nothing reads and
// nothing deletes — the same failure mode as an item missing from the erasure
// sweep, reached by a different route. `sessionExpiresAt()` in lib/sessions.ts
// is the single source of the value so the parts of a session cannot expire at
// different times.
//
// Deliberately NOT on USER#<uid>/PROFILE or USER#<uid>/PLAN. Those are the
// account, not a session artefact, and an account that quietly evaporates after
// a period of not interviewing is a bug, not a retention policy.
const SessionTtlSchema = z.number().int().positive().optional();

// The lifecycle a session moves through. `failed` is terminal and deliberately
// distinct from an absent session — a candidate whose interview broke mid-way
// should see that it broke, not that it never existed.
export const SessionStatusSchema = z.enum([
  "planning",
  "ready",
  "in_progress",
  "evaluating",
  "complete",
  "failed",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const QuestionTypeSchema = z.enum([
  "behavioural",
  "technical",
  "role_specific",
]);

export type QuestionType = z.infer<typeof QuestionTypeSchema>;

// SESSION#<sid> / META — created when the candidate submits their resume and
// GitHub, then updated as the Planner and the interview progress.
//
// `plan` is optional because the item is written at status `planning`, before
// the Planner has run. Making it required would mean either delaying the write
// until after a Bedrock call — losing the session entirely if that call fails —
// or writing a placeholder plan that reads as real.
export const SessionMetaSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_META).default(ITEM_TYPE.SESSION_META),
  expiresAt: SessionTtlSchema,
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  status: SessionStatusSchema,
  createdAt: z.iso.datetime(),
  // Optional until the Planner runs. The pre-interview step collects a resume
  // and a GitHub profile but not a target role — that arrives with the plan
  // request. Requiring it here would mean either storing a placeholder that
  // reads as real, or delaying the session write until the second step and
  // losing the uploaded resume if the candidate abandons.
  role: z.string().min(1).optional(),
  plan: PlanResponseSchema.optional(),
  questionCount: z.number().int().min(0).optional(),
  resumeKey: z.string().min(1).optional(),
  githubUsername: z.string().min(1).optional(),
});

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

// SESSION#<sid> / INPUTS — the candidate material the Planner reads: scraped
// repositories and extracted resume text, captured at pre-interview time.
//
// A separate item rather than attributes on META, for the reason data-model.md
// §1 gives for splitting transcripts per answer: DynamoDB bills an update
// against the whole item's size, not the delta. This is roughly 10 KB and META
// takes four status updates across a session, so folding it in would cost about
// 40 WCU instead of 4 — on the one item the interview loop reads repeatedly.
//
// Written once and never updated. Its existence is what lets POST /plan stop
// trusting the client to re-send repos and resume text, which it otherwise
// could substitute with someone else's.
export const SessionInputsSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_INPUTS).default(ITEM_TYPE.SESSION_INPUTS),
  expiresAt: SessionTtlSchema,
  repos: z.array(PreInterviewRepo).max(PLAN_LIMITS.MAX_REPOS),
  // Truncated on write to PLAN_LIMITS.MAX_RESUME_CHARS. The parser's output is
  // unbounded — a 60-page PDF is not a resume, but it is a 400 KB item, and the
  // per-item ceiling is not somewhere to discover that.
  resumeText: z.string().max(PLAN_LIMITS.MAX_RESUME_CHARS),
  // The S3 object the text came from, so a future parser change can be re-run
  // against the original without asking the candidate to re-upload.
  resumeKey: z.string().min(1),
});

export type SessionInputs = z.infer<typeof SessionInputsSchema>;

// SESSION#<sid> / ANSWER#<qId> — one exchange. Both text fields come from the
// same Sonic `textOutput` stream, distinguished by role, and both are
// transcripts of audio already spoken rather than the source of it.
export const SessionAnswerSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_ANSWER).default(ITEM_TYPE.SESSION_ANSWER),
  expiresAt: SessionTtlSchema,
  questionId: z.string().min(1),
  questionText: z.string(),
  questionType: QuestionTypeSchema,
  askedAt: z.iso.datetime(),
  transcript: z.string(),
  // Nullable, not optional. Audio persistence is best-effort and a failed
  // upload must not fail the interview turn, so "we tried and there is none"
  // is a real state the Evaluator can encounter.
  audioKey: z.string().min(1).nullable(),
  durationMs: z.number().int().min(0),
  // Barge-in is possible over a bidirectional stream. An answer given over a
  // half-delivered question is not comparable to one given after the whole
  // question, and the Evaluator needs to know which it is looking at.
  interrupted: z.boolean(),
});

export type SessionAnswer = z.infer<typeof SessionAnswerSchema>;

// SESSION#<sid> / EVAL#<qId>
export const SessionEvaluationSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_EVALUATION).default(ITEM_TYPE.SESSION_EVALUATION),
  expiresAt: SessionTtlSchema,
  questionId: z.string().min(1),
  correctness: z.number().min(0).max(10),
  clarity: z.number().min(0).max(10),
  depth: z.number().min(0).max(10),
  rationale: z.string().min(1),
  // Which model produced this. When the primary is unavailable and the request
  // falls through the chain, scores from two different models are not strictly
  // comparable — and without this attribute that is invisible forever.
  modelId: z.string().min(1),
  evaluatedAt: z.iso.datetime(),
});

export type SessionEvaluation = z.infer<typeof SessionEvaluationSchema>;

// SESSION#<sid> / EVAL#SUMMARY
//
// No `completedCount`. data-model.md §1 works through why: `ADD completedCount
// 1` is not idempotent, and SQS is at-least-once, so a redelivered message
// over-counts and the Coach fires early. Completion is derived from
// `Query ... begins_with EVAL#` instead, which is exact by construction and
// also removes a hot single-item write from every evaluation.
export const SessionEvalSummarySchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_EVAL_SUMMARY).default(ITEM_TYPE.SESSION_EVAL_SUMMARY),
  expiresAt: SessionTtlSchema,
  questionCount: z.number().int().min(0),
  averages: z
    .object({
      correctness: z.number().min(0).max(10),
      clarity: z.number().min(0).max(10),
      depth: z.number().min(0).max(10),
    })
    .optional(),
});

export type SessionEvalSummary = z.infer<typeof SessionEvalSummarySchema>;

// SESSION#<sid> / COACH
export const SessionCoachSchema = z.object({
  type: z.literal(ITEM_TYPE.SESSION_COACH).default(ITEM_TYPE.SESSION_COACH),
  expiresAt: SessionTtlSchema,
  plan: z.array(z.string().min(1)),
  citations: z.array(z.string().min(1)),
  generatedAt: z.iso.datetime(),
});

export type SessionCoach = z.infer<typeof SessionCoachSchema>;

// USER#<uid> / SESSION#<sid> — the lookup item that makes a user's history a
// plain base-table Query, and the reason the table needs no GSI.
//
// The USER#<uid> partition is no longer session items alone: it also holds
// PROFILE and PLAN. Both sort before "SESSION#" lexicographically, so a history
// query MUST filter with `begins_with(SK, "SESSION#")` rather than reading the
// whole partition — an unfiltered Query would hand the caller a profile item
// and fail to parse as a session ref.
//
// Written once and never updated. It deliberately carries no `status` and no
// `role`, both of which change after creation: a denormalised copy has to be
// rewritten on every transition and drifts silently the first time one of those
// writes fails. Keeping this item immutable makes that class of bug impossible,
// at the cost of one BatchGetItem against the META items when a history list
// needs live status. That is a rare read traded for an inconsistency that would
// otherwise be invisible until a candidate saw a stale label.
export const UserSessionRefSchema = z.object({
  type: z.literal(ITEM_TYPE.USER_SESSION_REF).default(ITEM_TYPE.USER_SESSION_REF),
  expiresAt: SessionTtlSchema,
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.iso.datetime(),
});

export type UserSessionRef = z.infer<typeof UserSessionRefSchema>;
