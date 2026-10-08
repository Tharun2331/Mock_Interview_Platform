import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  ITEM_TYPE,
  SORT_KEY,
  answerSk,
  evalSk,
  sessionPk,
  type EvalJob,
} from "@repo/shared";
import {
  lastToolCall,
  resetBedrockStub,
  resetStructuredStub,
  setAnsweringModel,
  setToolFailure,
  setToolReply,
} from "./helpers/bedrockStub";

const { handleMessage } = await import("../worker");
const { EVALUATOR_TOOL_NAME } = await import("../agents/evaluator");

// The Evaluator answers through a forced tool call. These keep this file's
// vocabulary: an object is the tool's reply, a string a model answering in prose.
const setModelReply = (value: unknown) =>
  setToolReply(EVALUATOR_TOOL_NAME, value);
const setModelFailure = (error: Error) =>
  setToolFailure(EVALUATOR_TOOL_NAME, error);
const lastConverseCall = () => lastToolCall(EVALUATOR_TOOL_NAME);
const { BedrockError, GuardrailBlockedError, ServiceError } =
  await import("../lib/errors");

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const QUESTION_ID = "q1";
const NOW = "2026-09-09T12:00:00.000Z";

const SCORES = {
  correctness: 7,
  clarity: 6,
  depth: 4,
  rationale: "You named the tradeoff but did not point at a system you built.",
};

const ANSWER = {
  PK: sessionPk(SESSION_ID),
  SK: answerSk(QUESTION_ID),
  type: ITEM_TYPE.SESSION_ANSWER,
  questionId: QUESTION_ID,
  questionText: "How do you decide between a queue and a direct call?",
  questionType: "technical",
  askedAt: NOW,
  transcript: "Queues are good when you want things asynchronous.",
  audioKey: null,
  durationMs: 48_000,
  interrupted: false,
};

const META = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.META,
  type: ITEM_TYPE.SESSION_META,
  sessionId: SESSION_ID,
  userId: "user-1",
  status: "evaluating",
  createdAt: NOW,
  role: "Backend Engineer",
  plan: {
    focusAreas: [
      { area: "Kafka", evidence: "order-service", source: "github" },
      { area: "Postgres", evidence: "order-service", source: "github" },
    ],
    questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
    startingDifficulty: "senior",
    targetMinutes: 30,
    reasoning: "why",
  },
};

const EXISTING_EVAL = {
  PK: sessionPk(SESSION_ID),
  SK: evalSk(QUESTION_ID),
  type: ITEM_TYPE.SESSION_EVALUATION,
  questionId: QUESTION_ID,
  correctness: 5,
  clarity: 5,
  depth: 5,
  rationale: "scored earlier",
  modelId: "mistral.ministral-3-8b-instruct",
  evaluatedAt: NOW,
};

function itemsFound(items: Record<string, unknown>[]) {
  ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: items } });
}

const JOB: EvalJob = { sessionId: SESSION_ID, questionId: QUESTION_ID };

function body(job: unknown = JOB): string {
  return JSON.stringify(job);
}

// The completion check runs after every score. Defaults here make it a no-op —
// no rollup, nothing scored — so tests about scoring itself are not also
// asserting about finalisation. The completion tests set their own.
function summaryIs(item: Record<string, unknown> | undefined) {
  ddb.on(GetCommand).resolves(item === undefined ? {} : { Item: item });
}

function evaluationsScored(count: number) {
  ddb.on(QueryCommand).resolves({
    Items: Array.from({ length: count }, () => ({
      correctness: 6,
      clarity: 7,
      depth: 5,
    })),
  });
}

beforeEach(() => {
  ddb.reset();
  resetBedrockStub();
  resetStructuredStub();
  setModelReply(SCORES);
  ddb.on(PutCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  summaryIs(undefined);
  evaluationsScored(0);
});

afterAll(() => ddb.restore());

describe("scoring a queued answer", () => {
  it("reads the answer, scores it and writes the evaluation", async () => {
    itemsFound([ANSWER, META]);

    const outcome = await handleMessage(body());

    expect(outcome.kind).toBe("scored");
    const item = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.SK).toBe(evalSk(QUESTION_ID));
    expect(item?.correctness).toBe(7);
    expect(item?.rationale).toBe(SCORES.rationale);
  });

  it("stamps the evaluation with the model that produced it", async () => {
    itemsFound([ANSWER, META]);
    setAnsweringModel("us.meta.llama4-scout-17b-instruct-v1:0");

    await handleMessage(body());

    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item?.modelId).toBe(
      "us.meta.llama4-scout-17b-instruct-v1:0",
    );
  });

  // Every session-scoped item carries one, or it outlives the session it
  // belongs to and becomes an orphan nothing reads and nothing deletes.
  it("gives the evaluation a TTL", async () => {
    itemsFound([ANSWER, META]);

    await handleMessage(body());

    expect(
      ddb.commandCalls(PutCommand)[0]?.args[0].input.Item?.expiresAt,
    ).toBeGreaterThan(0);
  });

  // PutItem keyed by questionId, conditioned on nothing — a redelivery that
  // slips past the read overwrites rather than duplicating, which is why
  // completion can be counted from the EVAL# prefix.
  it("writes unconditionally so a redelivery cannot duplicate the item", async () => {
    itemsFound([ANSWER, META]);

    await handleMessage(body());

    expect(
      ddb.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression,
    ).toBeUndefined();
  });

  it("passes the session's role and opening difficulty to the model", async () => {
    itemsFound([ANSWER, META]);

    await handleMessage(body());

    const prompt = lastConverseCall()?.prompt ?? "";
    expect(prompt).toContain("Target role: Backend Engineer");
    expect(prompt).toContain("Interview opened at: senior");
  });

  // An interview that ran has answers worth scoring even if its META predates
  // the plan attribute.
  it("falls back rather than failing when the plan is missing", async () => {
    const { plan: _dropped, role: _alsoDropped, ...bare } = META;
    itemsFound([ANSWER, bare]);

    const outcome = await handleMessage(body());

    expect(outcome.kind).toBe("scored");
    expect(lastConverseCall()?.prompt).toContain("Interview opened at: mid");
  });
});

// A redelivered message costs one strongly consistent read instead of a full
// generation. This is the real version of what a FIFO queue only appears to
// offer.
describe("the duplicate guard", () => {
  it("skips a question that has already been scored", async () => {
    itemsFound([ANSWER, META, EXISTING_EVAL]);

    const outcome = await handleMessage(body());

    expect(outcome.kind).toBe("already-scored");
  });

  it("does not call the model for a duplicate", async () => {
    itemsFound([ANSWER, META, EXISTING_EVAL]);

    await handleMessage(body());

    expect(lastConverseCall()).toBeUndefined();
  });

  it("does not overwrite the evaluation that already exists", async () => {
    itemsFound([ANSWER, META, EXISTING_EVAL]);

    await handleMessage(body());

    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  // An eventually consistent read can miss an evaluation written seconds ago by
  // a redelivery of this very message, which is exactly the window being
  // guarded.
  it("reads strongly consistent", async () => {
    itemsFound([ANSWER, META]);

    await handleMessage(body());

    expect(
      ddb.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[TABLE]
        ?.ConsistentRead,
    ).toBe(true);
  });

  // The answer has to be read anyway, so the duplicate check costs no extra
  // round trip.
  it("fetches the answer, the meta and the existing evaluation in one call", async () => {
    itemsFound([ANSWER, META]);

    await handleMessage(body());

    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(1);
    const keys =
      ddb.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[TABLE]
        ?.Keys ?? [];
    expect(keys.map((key) => key.SK)).toEqual([
      answerSk(QUESTION_ID),
      SORT_KEY.META,
      evalSk(QUESTION_ID),
    ]);
  });
});

// Neither is retryable and neither is an error — there is simply nothing to
// score, so the message is finished with.
describe("messages with nothing to do", () => {
  it("drops a job whose answer was never written", async () => {
    itemsFound([META]);

    const outcome = await handleMessage(body());

    expect(outcome.kind).toBe("no-answer");
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("drops a job for a session that has since been erased", async () => {
    itemsFound([]);

    expect((await handleMessage(body())).kind).toBe("no-answer");
  });

  // A retry cannot fix a malformed body, so cycling it to the DLQ three
  // receives later only delays the same conclusion.
  it("reports an unparseable body rather than throwing", async () => {
    expect((await handleMessage("not json")).kind).toBe("unparseable");
  });

  it("reports a body that parses but is not a job", async () => {
    expect((await handleMessage(body({ nothing: "useful" }))).kind).toBe(
      "unparseable",
    );
    expect(
      (await handleMessage(body({ sessionId: "", questionId: "" }))).kind,
    ).toBe("unparseable");
  });

  it("does not call the model for an unparseable message", async () => {
    await handleMessage("not json");

    expect(lastConverseCall()).toBeUndefined();
  });
});

// Nothing else triggers this. The queue going empty is not an event anything
// observes, so the check runs after every score and the last one closes the
// session out.
describe("completion detection", () => {
  const SUMMARY = {
    PK: sessionPk(SESSION_ID),
    SK: SORT_KEY.EVAL_SUMMARY,
    type: ITEM_TYPE.SESSION_EVAL_SUMMARY,
    questionCount: 3,
  };

  function finalizeUpdates() {
    return ddb
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.Key?.SK === SORT_KEY.EVAL_SUMMARY);
  }

  function statusUpdates() {
    return ddb
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.Key?.SK === SORT_KEY.META);
  }

  it("does nothing while answers are still outstanding", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    evaluationsScored(2);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ kind: "scored", finalized: "incomplete" });
    expect(finalizeUpdates()).toHaveLength(0);
    expect(statusUpdates()).toHaveLength(0);
  });

  it("writes the averages and completes the session on the last answer", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ kind: "scored", finalized: "finalized" });
    expect(
      finalizeUpdates()[0]?.args[0].input.ExpressionAttributeValues?.[
        ":averages"
      ],
    ).toEqual({ correctness: 6, clarity: 7, depth: 5 });
  });

  it("moves the session out of evaluating only once the rollup is written", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    await handleMessage(body());

    const status = statusUpdates()[0]?.args[0].input;
    expect(status?.ExpressionAttributeValues?.[":complete"]).toBe("complete");
    // Conditioned, so a retried message cannot drag a session that has since
    // moved on back to complete.
    expect(status?.ConditionExpression).toBe("#status = :evaluating");
  });

  // Two workers can finish their final message milliseconds apart and both
  // count the same total. The conditional update is what makes exactly one of
  // them the winner — which matters more for Phase 6's Coach trigger than for
  // this write.
  it("elects a single finaliser when two workers race", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    evaluationsScored(3);
    const failure = new ConditionalCheckFailedException({
      $metadata: {},
      message: "failed",
    });
    ddb.on(UpdateCommand).rejects(failure);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ finalized: "already-finalized" });
    // The loser must not also complete the session.
    expect(statusUpdates()).toHaveLength(0);
  });

  it("does not finalise twice when the rollup already has averages", async () => {
    itemsFound([ANSWER, META]);
    summaryIs({
      ...SUMMARY,
      averages: { correctness: 6, clarity: 7, depth: 5 },
    });
    evaluationsScored(3);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ finalized: "already-finalized" });
    expect(finalizeUpdates()).toHaveLength(0);
  });

  // The denominator is the answers actually enqueued, not the plan's
  // questionCount. An interview stopped early by the hard timer produces fewer
  // answers than it planned, and waiting for the planned number would park the
  // session at `evaluating` forever.
  it("completes an interview that ended early, against its own denominator", async () => {
    // The plan called for 10; the hard timer stopped it after 2.
    itemsFound([ANSWER, { ...META, questionCount: 10 }]);
    summaryIs({ ...SUMMARY, questionCount: 2 });
    evaluationsScored(2);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ finalized: "finalized" });
  });

  // The rollup is `SUMMARY`, not `EVAL#SUMMARY`, precisely so it is not
  // returned by this query and counted as an evaluation.
  it("counts only EVAL# items, using a strongly consistent read", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    await handleMessage(body());

    const query = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(query?.ExpressionAttributeValues?.[":prefix"]).toBe("EVAL#");
    // An eventually consistent read can miss the evaluation this very worker
    // just wrote, conclude the session is one short, and leave it stuck with
    // nothing left in the queue to look again.
    expect(query?.ConsistentRead).toBe(true);
  });

  // `depth` is a DynamoDB reserved word. Unaliased it fails the request
  // outright rather than returning nothing, and aws-sdk-client-mock does not
  // validate expressions against the reserved-word list — so this asserts the
  // aliasing directly. It cost a stuck session on the first real run.
  it("aliases every projected attribute, since `depth` is reserved", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    await handleMessage(body());

    const query = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    // Lookbehind for the alias marker: `#depth` is fine, a bare `depth` is the
    // bug. Without it, \b matches straight after the `#` and the assertion
    // passes on the broken and the fixed expression alike.
    expect(query?.ProjectionExpression).not.toMatch(/(?<!#)\bdepth\b/);
    expect(query?.ExpressionAttributeNames?.["#depth"]).toBe("depth");
  });

  // The duplicate guard skips the MODEL call, never the completion check.
  // Returning early here is what left a session stuck at `evaluating`: the
  // evaluations were all written, the check threw, the messages were
  // redelivered, and every redelivery short-circuited before asking again.
  it("still checks completion when the answer was already scored", async () => {
    itemsFound([ANSWER, META, EXISTING_EVAL]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({
      kind: "already-scored",
      finalized: "finalized",
    });
    expect(finalizeUpdates()).toHaveLength(1);
  });

  it("recovers a session whose earlier completion check failed", async () => {
    // Every answer scored, but the rollup never got its averages because the
    // check threw last time round. A redelivery must finish the job.
    itemsFound([ANSWER, META, EXISTING_EVAL]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    await handleMessage(body());

    expect(
      statusUpdates()[0]?.args[0].input.ExpressionAttributeValues?.[
        ":complete"
      ],
    ).toBe("complete");
  });

  it("still checks completion when there is no answer to score", async () => {
    itemsFound([META]);
    summaryIs(SUMMARY);
    evaluationsScored(3);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({
      kind: "no-answer",
      finalized: "finalized",
    });
  });

  it("reports no-summary rather than failing when the rollup is absent", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(undefined);

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ kind: "scored", finalized: "no-summary" });
  });
});

// Throws only on failures a retry could plausibly fix. The caller leaves those
// messages undeleted so SQS redelivers, and maxReceiveCount routes them to the
// DLQ — which is the retry the Evaluator relies on instead of a model chain.
describe("failures that should be retried", () => {
  it("propagates an exhausted model chain", async () => {
    itemsFound([ANSWER, META]);
    setModelFailure(new BedrockError("all models failed", ["ministral"]));

    await expect(handleMessage(body())).rejects.toThrow(BedrockError);
  });

  it("propagates a read failure", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("throughput exceeded"));

    await expect(handleMessage(body())).rejects.toThrow(ServiceError);
  });

  it("propagates a write failure, so the score is not silently lost", async () => {
    itemsFound([ANSWER, META]);
    ddb.on(PutCommand).rejects(new Error("throughput exceeded"));

    await expect(handleMessage(body())).rejects.toThrow(ServiceError);
  });

  // A generation that cannot be parsed is not retryable by re-reading, but it
  // may well succeed on a second call to the model.
  it("propagates an unusable generation", async () => {
    itemsFound([ANSWER, META]);
    setModelReply("the candidate did quite well I think");

    await expect(handleMessage(body())).rejects.toThrow(BedrockError);
  });
});

// ADR-0010. A guardrail block is deterministic — the same answer is refused on
// every retry — so it must neither cycle to the DLQ nor leave its session
// waiting at `evaluating` for an EVAL# item that will never be written.
describe("an answer the guardrail blocks", () => {
  const SUMMARY = {
    PK: sessionPk(SESSION_ID),
    SK: SORT_KEY.EVAL_SUMMARY,
    type: ITEM_TYPE.SESSION_EVAL_SUMMARY,
    questionCount: 3,
  };

  const blocked = () =>
    setModelFailure(
      new GuardrailBlockedError("Bedrock Guardrail blocked the call", [
        "mistral.ministral-3-8b-instruct",
      ]),
    );

  function unscoredWrites() {
    return ddb
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.UpdateExpression?.startsWith("ADD"));
  }

  function statusUpdates() {
    return ddb
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.Key?.SK === SORT_KEY.META);
  }

  it("returns rather than throwing, so the message is not redelivered", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    blocked();

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({
      kind: "unscored",
      questionId: QUESTION_ID,
    });
  });

  it("records the answer on the rollup as a set, so a redelivery cannot double count", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    blocked();

    await handleMessage(body());

    const write = unscoredWrites()[0]?.args[0].input;
    expect(write?.Key).toEqual({
      PK: sessionPk(SESSION_ID),
      SK: SORT_KEY.EVAL_SUMMARY,
    });
    expect(write?.ExpressionAttributeNames?.["#unscored"]).toBe(
      "unscoredQuestionIds",
    );
    expect(write?.ExpressionAttributeValues?.[":questionIds"]).toEqual(
      new Set([QUESTION_ID]),
    );
    // ADD on a missing item would create a rollup with no questionCount.
    expect(write?.ConditionExpression).toBe("attribute_exists(PK)");
  });

  it("writes no evaluation", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    blocked();

    await handleMessage(body());

    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("completes the session when it was the last answer outstanding", async () => {
    itemsFound([ANSWER, META]);
    // Two scored, this one blocked: three of three accounted for.
    summaryIs({ ...SUMMARY, unscoredQuestionIds: new Set([QUESTION_ID]) });
    evaluationsScored(2);
    blocked();

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ kind: "unscored", finalized: "finalized" });
    expect(
      statusUpdates()[0]?.args[0].input.ExpressionAttributeValues?.[
        ":complete"
      ],
    ).toBe("complete");
  });

  it("averages only the answers that were scored", async () => {
    itemsFound([ANSWER, META]);
    summaryIs({ ...SUMMARY, unscoredQuestionIds: new Set([QUESTION_ID]) });
    evaluationsScored(2);
    blocked();

    await handleMessage(body());

    const rollup = ddb
      .commandCalls(UpdateCommand)
      .find(
        (call) =>
          call.args[0].input.UpdateExpression === "SET averages = :averages",
      );
    expect(
      rollup?.args[0].input.ExpressionAttributeValues?.[":averages"],
    ).toEqual({ correctness: 6, clarity: 7, depth: 5 });
  });

  it("does not count an answer twice when it was blocked and later scored", async () => {
    itemsFound([ANSWER, META]);
    summaryIs({ ...SUMMARY, unscoredQuestionIds: new Set([QUESTION_ID]) });
    // q1 is in the unscored set AND has a score; q2 scored. Two of three.
    ddb.on(QueryCommand).resolves({
      Items: [
        { questionId: QUESTION_ID, correctness: 6, clarity: 7, depth: 5 },
        { questionId: "q2", correctness: 6, clarity: 7, depth: 5 },
      ],
    });
    blocked();

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({ finalized: "incomplete" });
    expect(statusUpdates()).toHaveLength(0);
  });

  // Nothing to average: a mean of nothing is NaN, which the rollup's schema
  // would reject on every later read. The session must still leave
  // `evaluating`.
  it("completes a session whose every answer was blocked, without averages", async () => {
    itemsFound([ANSWER, META]);
    summaryIs({
      ...SUMMARY,
      questionCount: 1,
      unscoredQuestionIds: new Set([QUESTION_ID]),
    });
    evaluationsScored(0);
    blocked();

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({
      kind: "unscored",
      finalized: "all-unscored",
    });
    expect(
      ddb
        .commandCalls(UpdateCommand)
        .some(
          (call) =>
            call.args[0].input.UpdateExpression === "SET averages = :averages",
        ),
    ).toBe(false);
    expect(
      statusUpdates()[0]?.args[0].input.ExpressionAttributeValues?.[
        ":complete"
      ],
    ).toBe("complete");
  });

  it("tolerates a session with no rollup to record against", async () => {
    itemsFound([ANSWER, META]);
    ddb.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      }),
    );
    blocked();

    const outcome = await handleMessage(body());

    expect(outcome).toMatchObject({
      kind: "unscored",
      finalized: "no-summary",
    });
  });

  // Every other Bedrock failure is still the queue's to retry.
  it("still propagates an ordinary model failure", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    setModelFailure(new BedrockError("All Bedrock text models failed"));

    await expect(handleMessage(body())).rejects.toThrow(BedrockError);
    expect(unscoredWrites()).toHaveLength(0);
  });
});

// Dev, 2026-10-07: Ministral returned no `rationale` three times running for
// one answer of fifteen. Thrown from the last delivery, the message went to the
// DLQ and the session would have waited at `evaluating` forever.
describe("a model failure on the final attempt", () => {
  const SUMMARY = {
    PK: sessionPk(SESSION_ID),
    SK: SORT_KEY.EVAL_SUMMARY,
    type: ITEM_TYPE.SESSION_EVAL_SUMMARY,
    questionCount: 3,
  };

  const unscoredWrites = () =>
    ddb
      .commandCalls(UpdateCommand)
      .filter((call) => call.args[0].input.UpdateExpression?.startsWith("ADD"));

  it("is recorded as unscored instead of failing a last time", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    setModelFailure(new BedrockError("Evaluator output failed validation"));

    const outcome = await handleMessage(body(), { finalAttempt: true });

    expect(outcome).toMatchObject({
      kind: "unscored",
      questionId: QUESTION_ID,
    });
    expect(unscoredWrites()).toHaveLength(1);
  });

  it("completes the session when it was the last answer", async () => {
    itemsFound([ANSWER, META]);
    summaryIs({ ...SUMMARY, unscoredQuestionIds: new Set([QUESTION_ID]) });
    evaluationsScored(2);
    setModelFailure(new BedrockError("Evaluator output failed validation"));

    const outcome = await handleMessage(body(), { finalAttempt: true });

    expect(outcome).toMatchObject({ kind: "unscored", finalized: "finalized" });
  });

  // Earlier deliveries still go back to SQS: a second generation often works.
  it("still throws before the final attempt, so SQS retries it", async () => {
    itemsFound([ANSWER, META]);
    summaryIs(SUMMARY);
    setModelFailure(new BedrockError("Evaluator output failed validation"));

    await expect(
      handleMessage(body(), { finalAttempt: false }),
    ).rejects.toThrow(BedrockError);
    expect(unscoredWrites()).toHaveLength(0);
  });

  // Recording the answer needs DynamoDB too, so a DynamoDB failure has nothing
  // better to do than reach the DLQ, where the depth alarm reports it.
  it("still throws a non-model failure on the final attempt", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("throughput exceeded"));

    await expect(handleMessage(body(), { finalAttempt: true })).rejects.toThrow(
      ServiceError,
    );
  });
});
