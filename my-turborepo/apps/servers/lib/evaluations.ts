import { BatchGetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ITEM_TYPE,
  SORT_KEY,
  SessionAnswerSchema,
  SessionMetaSchema,
  answerSk,
  evalSk,
  sessionPk,
  type EvaluatorInput,
  type SessionAnswer,
  type SessionMeta,
} from "@repo/shared";
import { dynamoClient, parseItem, requireTable } from "./dynamo";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";
import { sessionExpiresAt } from "./sessions";

// Every DynamoDB command for EVAL# items, matching how lib/sessions.ts owns the
// session lifecycle and lib/profile.ts owns the user-scoped items. The worker
// decides what to do with an outcome; this decides key layout.

// What a queued job resolves to. Three outcomes, because the worker has to tell
// them apart: score it, skip it as already done, or drop it as unscoreable.
export type EvaluationJobState =
  | { kind: "ready"; input: EvaluatorInput; answer: SessionAnswer }
  // A redelivered message whose evaluation already landed. SQS is at-least-once
  // and Bedrock is the expensive part, so recognising this is worth one read.
  | { kind: "already-scored" }
  // No answer at that key. Either the write failed and was logged, or the
  // session has since been erased. Neither is retryable and neither is an
  // error — there is simply nothing to score.
  | { kind: "no-answer" };

// One BatchGetItem for all three items rather than three GetItems: the answer
// to score, the META that carries the plan context, and the evaluation that may
// already exist. The duplicate check costs nothing extra because the answer has
// to be read anyway.
export async function loadEvaluationJob(args: {
  sessionId: string;
  questionId: string;
}): Promise<EvaluationJobState> {
  const TableName = requireTable();
  const pk = sessionPk(args.sessionId);

  let response;
  try {
    response = await dynamoClient.send(
      new BatchGetCommand({
        RequestItems: {
          [TableName]: {
            Keys: [
              { PK: pk, SK: answerSk(args.questionId) },
              { PK: pk, SK: SORT_KEY.META },
              { PK: pk, SK: evalSk(args.questionId) },
            ],
            // Strongly consistent. The duplicate check is the reason: an
            // eventually consistent read can miss an evaluation written seconds
            // ago by a redelivery of this very message, which is exactly the
            // window this is guarding.
            ConsistentRead: true,
          },
        },
      })
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.SESSION_READ_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  // BatchGetItem returns matches unordered and omits misses, so items are found
  // by sort key rather than by position.
  const items = response.Responses?.[TableName] ?? [];
  const answerItem = items.find((item) => item.SK === answerSk(args.questionId));
  const metaItem = items.find((item) => item.SK === SORT_KEY.META);
  const existing = items.find((item) => item.SK === evalSk(args.questionId));

  if (existing !== undefined) return { kind: "already-scored" };
  if (answerItem === undefined) return { kind: "no-answer" };

  const answer = parseItem(SessionAnswerSchema, answerItem, "ANSWER");
  const meta = parseItem(SessionMetaSchema, metaItem, "META");

  return { kind: "ready", answer, input: toEvaluatorInput(answer, meta) };
}

// The plan is what supplies the role and the opening difficulty. Both are
// context for calibration rather than inputs to the score, which is why an
// absent plan falls back rather than failing: an interview that ran has
// answers worth scoring even if its META is older than the plan attribute.
function toEvaluatorInput(
  answer: SessionAnswer,
  meta: SessionMeta
): EvaluatorInput {
  return {
    questionText: answer.questionText,
    questionType: answer.questionType,
    transcript: answer.transcript,
    interrupted: answer.interrupted,
    durationMs: answer.durationMs,
    targetRole: meta.role ?? "the role they applied for",
    startingDifficulty: meta.plan?.startingDifficulty ?? "mid",
  };
}

// PutItem, unconditionally. SQS is at-least-once, so a redelivery that slips
// past the read above overwrites the same item rather than creating a second
// one — which is the whole reason completion can be derived by counting this
// prefix instead of incrementing a counter that duplicates would corrupt.
export async function putEvaluation(args: {
  sessionId: string;
  questionId: string;
  correctness: number;
  clarity: number;
  depth: number;
  rationale: string;
  modelId: string;
}): Promise<void> {
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: requireTable(),
        Item: {
          PK: sessionPk(args.sessionId),
          SK: evalSk(args.questionId),
          type: ITEM_TYPE.SESSION_EVALUATION,
          // Every session-scoped item carries one, or it outlives the session
          // it belongs to and becomes an orphan nothing reads and nothing
          // deletes.
          expiresAt: sessionExpiresAt(),
          questionId: args.questionId,
          correctness: args.correctness,
          clarity: args.clarity,
          depth: args.depth,
          rationale: args.rationale,
          // Which model produced this. Scores from two different models are not
          // strictly comparable, and without this attribute that is invisible
          // forever.
          modelId: args.modelId,
          evaluatedAt: new Date().toISOString(),
        },
      })
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.EVAL_WRITE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
}
