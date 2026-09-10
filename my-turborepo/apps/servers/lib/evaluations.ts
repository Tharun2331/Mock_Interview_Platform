import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ITEM_TYPE,
  KEY_PREFIX,
  SORT_KEY,
  SessionAnswerSchema,
  SessionEvalSummarySchema,
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
import { completeEvaluation, sessionExpiresAt } from "./sessions";

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

// Opens the rollup when the interview ends, carrying the denominator that
// decides completion.
//
// **The count is the answers actually enqueued, NOT the plan's questionCount.**
// data-model.md §1 calls the planned count "the denominator for completion",
// and that is wrong for any interview that did not run to plan — which is most
// of them, since the hard timer exists precisely because they overrun. A
// session planned for ten questions that ended after six would wait for four
// evaluations that were never queued and sit at `evaluating` forever.
//
// Written before the messages are sent, so a worker can never find an
// evaluation to record with no rollup to record it against.
export async function startEvaluationSummary(args: {
  sessionId: string;
  questionCount: number;
}): Promise<void> {
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: requireTable(),
        Item: {
          PK: sessionPk(args.sessionId),
          SK: SORT_KEY.EVAL_SUMMARY,
          type: ITEM_TYPE.SESSION_EVAL_SUMMARY,
          expiresAt: sessionExpiresAt(),
          questionCount: args.questionCount,
          // `averages` is deliberately absent until every answer is scored. Its
          // absence is the election below: exactly one worker can add it.
        },
      })
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.EVAL_SUMMARY_WRITE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
}

// What a completion check concluded. Four outcomes, because the worker logs
// them differently and only one of them is a state change.
export type FinalizeOutcome =
  | { kind: "incomplete"; scored: number; expected: number }
  | { kind: "finalized"; scored: number; averages: EvaluationAverages }
  // Another worker's final message got there first. Not an error — exactly one
  // of the two was always going to win.
  | { kind: "already-finalized" }
  // No rollup to complete against. Only reachable for a session enqueued before
  // this existed, or one whose items have been erased mid-flight.
  | { kind: "no-summary" };

export type EvaluationAverages = {
  correctness: number;
  clarity: number;
  depth: number;
};

// One decimal. These are read by a person against a 0-10 scale, and
// 6.733333333333333 communicates nothing 6.7 does not.
function mean(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}

// Every evaluation written for a session, with just the attributes the rollup
// needs.
//
// Strongly consistent, and that is the whole point: an eventually consistent
// read can miss the evaluation this very worker wrote a moment ago, conclude
// the session is one short, and leave it at `evaluating` with nothing left in
// the queue to trigger another check. data-model.md §1 calls this out
// explicitly — the completion check must be strongly consistent or it fires at
// the wrong time.
async function readEvaluationScores(
  sessionId: string
): Promise<EvaluationAverages[]> {
  const TableName = requireTable();
  const scores: EvaluationAverages[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    let response;
    try {
      response = await dynamoClient.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": sessionPk(sessionId),
            // This is why the rollup is `SUMMARY` and not `EVAL#SUMMARY`: it
            // would otherwise be returned here and counted as an evaluation,
            // completing the session one answer early.
            ":prefix": KEY_PREFIX.EVAL,
          },
          ProjectionExpression: "correctness, clarity, depth",
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        })
      );
    } catch (error) {
      throw new ServiceError(
        `${MESSAGES.SESSION_READ_FAILED} — ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    for (const item of response.Items ?? []) {
      const { correctness, clarity, depth } = item;
      if (
        typeof correctness === "number" &&
        typeof clarity === "number" &&
        typeof depth === "number"
      ) {
        scores.push({ correctness, clarity, depth });
      }
    }

    cursor = response.LastEvaluatedKey;
  } while (cursor !== undefined);

  return scores;
}

// Called after every evaluation is written. Decides whether that was the last
// one, and if so closes the session out.
//
// The election is `attribute_not_exists(averages)` on the rollup. Two workers
// finishing their final message milliseconds apart will both count the same
// total and both try to finalise; the conditional update means exactly one
// succeeds. That matters more for Phase 6 than for this write — the Coach must
// fire once, and this is the signal it will hang off.
export async function finalizeIfComplete(args: {
  sessionId: string;
}): Promise<FinalizeOutcome> {
  const TableName = requireTable();

  let summaryResponse;
  try {
    summaryResponse = await dynamoClient.send(
      new GetCommand({
        TableName,
        Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.EVAL_SUMMARY },
        ConsistentRead: true,
      })
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.EVAL_SUMMARY_READ_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  if (summaryResponse.Item === undefined) return { kind: "no-summary" };

  const summary = parseItem(
    SessionEvalSummarySchema,
    summaryResponse.Item,
    "SUMMARY"
  );

  // Already closed out by whoever finished first.
  if (summary.averages !== undefined) return { kind: "already-finalized" };

  const scores = await readEvaluationScores(args.sessionId);

  // `>=` rather than `===`. The count cannot exceed the denominator today, but
  // an equality check turns any future off-by-one into a session that waits
  // forever, and that failure is silent.
  if (scores.length < summary.questionCount) {
    return {
      kind: "incomplete",
      scored: scores.length,
      expected: summary.questionCount,
    };
  }

  const averages: EvaluationAverages = {
    correctness: mean(scores.map((score) => score.correctness)),
    clarity: mean(scores.map((score) => score.clarity)),
    depth: mean(scores.map((score) => score.depth)),
  };

  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.EVAL_SUMMARY },
        UpdateExpression: "SET averages = :averages",
        // The election. Whoever writes this first is the one that finishes the
        // session; everyone else is a no-op.
        ConditionExpression: "attribute_not_exists(averages)",
        ExpressionAttributeValues: { ":averages": averages },
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return { kind: "already-finalized" };
    }
    throw new ServiceError(
      `${MESSAGES.EVAL_SUMMARY_WRITE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  // After the rollup, deliberately. If this fails the session stays at
  // `evaluating` with a complete rollup sitting beside it, which is visibly
  // recoverable; the reverse would be a session reported complete with no
  // scores to show for it.
  await completeEvaluation({ sessionId: args.sessionId });

  return { kind: "finalized", scored: scores.length, averages };
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
