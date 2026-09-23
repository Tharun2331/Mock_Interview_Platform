import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import {
  ITEM_TYPE,
  SORT_KEY,
  answerSk,
  sessionPk,
  userPk,
  userSummarySk,
  type EvalJob,
} from "@repo/shared";
import { WORKER } from "../lib/constants";
import {
  resetBedrockStub,
  resetStructuredStub,
  setModelFailure,
  setModelReply,
  setStructuredReplies,
} from "./helpers/bedrockStub";

// The poll loop, and the one decision it makes that cannot be walked back:
// whether a message is deleted or left for redelivery.
//
// `worker.test.ts` covers `handleMessage` — what one job does. This covers what
// the LOOP does with the result, which is a different question and the one that
// decides whether a candidate's feedback survives a bad afternoon. A message
// deleted too eagerly is feedback nobody will ever see again; one left
// undeleted when it should have gone cycles to the DLQ and looks like an
// outage.
//
// `processMessage` is not exported, deliberately — it is reached through
// `runWorker`, which is how production reaches it too.

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);

const { runWorker } = await import("../worker");

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const QUESTION_ID = "q1";
const USER_ID = "user-1";
const NOW = "2026-09-09T12:00:00.000Z";

const JOB: EvalJob = { sessionId: SESSION_ID, questionId: QUESTION_ID };

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
  userId: USER_ID,
  status: "evaluating",
  createdAt: NOW,
  role: "Backend Engineer",
};

// Receives, counted. The stop flag is driven by this rather than by counting
// `shouldStop` calls, and that distinction matters: the loop asks
// `shouldStop()` once per WHILE pass AND again before every message, so a
// naive call counter trips mid-batch and abandons the messages the test is
// about. Driving it from the receive means a whole batch is always processed.
let receives = 0;

/** First receive returns these messages; the second returns an empty queue,
 *  which is what lets the loop finish the batch and then exit. */
function queued(...bodies: (string | undefined)[]): void {
  sqs.on(ReceiveMessageCommand).callsFake(() => {
    receives += 1;
    return receives === 1
      ? {
          Messages: bodies.map((Body, index) => ({
            Body,
            ReceiptHandle: `receipt-${index}`,
          })),
        }
      : {};
  });
}

/** Runs the loop until one batch has been drained. */
async function pollOnce(): Promise<void> {
  await runWorker(() => receives >= 2);
}

function deletedReceipts(): string[] {
  return sqs
    .commandCalls(DeleteMessageCommand)
    .map((call) => String(call.args[0].input.ReceiptHandle));
}

beforeEach(() => {
  ddb.reset();
  sqs.reset();
  receives = 0;
  resetBedrockStub();
  // Both halves of the shared stub. The Evaluator goes through `converseText`
  // and the Session Summarizer through `converseStructured`, and their call
  // counts are cumulative for the whole process — without this reset they
  // carry over from whichever file ran first.
  resetStructuredStub();
  setModelReply(JSON.stringify(SCORES));

  // A scoreable job by default: the answer and meta exist, nothing scored yet.
  ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [ANSWER, META] } });
  ddb.on(PutCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  // No rollup and nothing counted, so the completion check is a no-op.
  ddb.on(GetCommand).resolves({});
  ddb.on(QueryCommand).resolves({ Items: [] });

  // An empty queue by default, still counted so `pollOnce` can terminate.
  sqs.on(ReceiveMessageCommand).callsFake(() => {
    receives += 1;
    return {};
  });
  sqs.on(DeleteMessageCommand).resolves({});
});

afterAll(() => {
  ddb.restore();
  sqs.restore();
});

describe("how it polls", () => {
  // Without long polling an idle worker bills a request every few milliseconds
  // and gets nothing back for each one.
  it("long-polls the queue rather than spinning", async () => {
    await pollOnce();

    const input = sqs.commandCalls(ReceiveMessageCommand)[0]?.args[0].input;
    expect(input?.WaitTimeSeconds).toBe(WORKER.LONG_POLL_SECONDS);
  });

  // Must comfortably exceed one Bedrock call, or the message is redelivered
  // while the first attempt is still running and the second generation is paid
  // for twice. This is the number that makes the single-model config matter.
  it("claims each message for longer than a generation takes", async () => {
    await pollOnce();

    const input = sqs.commandCalls(ReceiveMessageCommand)[0]?.args[0].input;
    expect(input?.VisibilityTimeout).toBe(WORKER.VISIBILITY_TIMEOUT_SECONDS);
    expect(input?.MaxNumberOfMessages).toBe(WORKER.RECEIVE_BATCH_SIZE);
  });

  it("stops without polling at all when asked to stop immediately", async () => {
    await runWorker(() => true);

    expect(sqs.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
  });

  it("keeps polling until told to stop", async () => {
    let polls = 0;
    await runWorker(() => polls++ >= 3);

    expect(sqs.commandCalls(ReceiveMessageCommand).length).toBeGreaterThan(1);
  });

  // `response.Messages` is optional on the SDK type, and an empty long-poll
  // omits it rather than sending an empty array.
  it("survives a receive that returns no Messages key at all", async () => {
    await pollOnce();

    expect(deletedReceipts()).toHaveLength(0);
  });
});

// Every outcome that finishes with a message deletes it — including the ones
// that did no work. Leaving a message undeleted is a request for redelivery,
// and neither a duplicate, a missing answer nor a malformed body improves on a
// retry.
describe("what it deletes", () => {
  it("deletes a message it scored", async () => {
    queued(JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toEqual(["receipt-0"]);
  });

  // A retry cannot fix a malformed body, so cycling it to the DLQ three
  // receives later only delays the same conclusion.
  it("deletes an unparseable body rather than letting it cycle to the DLQ", async () => {
    queued("{not json at all");

    await pollOnce();

    expect(deletedReceipts()).toEqual(["receipt-0"]);
  });

  it("deletes a body that parses but is not a job", async () => {
    queued(JSON.stringify({ hello: "world" }));

    await pollOnce();

    expect(deletedReceipts()).toEqual(["receipt-0"]);
  });

  it("deletes a job whose answer was never written", async () => {
    // Meta only — no ANSWER item, so there is nothing to score and nothing
    // that will ever score it.
    ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [META] } });
    queued(JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toEqual(["receipt-0"]);
  });

  it("deletes every message in a batch", async () => {
    queued(JSON.stringify(JOB), JSON.stringify(JOB), JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toEqual(["receipt-0", "receipt-1", "receipt-2"]);
  });
});

// THE contract. A failure a retry could plausibly fix must leave the message
// alone: the visibility timeout returns it to the queue and maxReceiveCount
// routes it to the DLQ if it keeps failing. That redrive IS the Evaluator's
// retry mechanism — it is why the worker runs a single model instead of a
// fallback chain.
describe("what it leaves for redelivery", () => {
  it("leaves a message undeleted when the model chain is exhausted", async () => {
    setModelFailure(new Error("every model failed"));
    queued(JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toHaveLength(0);
  });

  it("leaves a message undeleted when the read fails", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    queued(JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toHaveLength(0);
  });

  // The score was generated and paid for. Deleting the message here would
  // discard it silently; leaving it means the generation is repeated, which is
  // the cheaper mistake.
  it("leaves a message undeleted when the evaluation write fails", async () => {
    ddb.on(PutCommand).rejects(new Error("throughput exceeded"));
    queued(JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toHaveLength(0);
  });

  // One poisoned message must not stop the ones behind it — they are different
  // answers, often from different candidates.
  it("keeps processing the rest of the batch after one fails", async () => {
    ddb
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [ANSWER, META] } });
    // The first message is malformed, the second is fine.
    queued("{broken", JSON.stringify(JOB));

    await pollOnce();

    expect(deletedReceipts()).toEqual(["receipt-0", "receipt-1"]);
  });

  // A message with no body or no receipt handle cannot be acted on OR deleted —
  // there is nothing to delete it with.
  it("ignores a message carrying no body", async () => {
    queued(undefined);

    await pollOnce();

    expect(deletedReceipts()).toHaveLength(0);
  });
});

describe("shutting down", () => {
  // SIGTERM is how ECS asks a task to end and how Spot announces a reclamation.
  // Finishing the message in flight and then exiting means its work is not
  // repeated by whoever picks it up next.
  it("abandons the rest of a batch once asked to stop", async () => {
    queued(JSON.stringify(JOB), JSON.stringify(JOB), JSON.stringify(JOB));

    // Stops after the first message is handled.
    let checks = 0;
    await runWorker(() => {
      checks += 1;
      // 1st call enters the loop, 2nd guards message one, 3rd stops.
      return checks > 2;
    });

    expect(deletedReceipts().length).toBeLessThan(3);
  });
});

// Hangs off the once-only finalisation election, which is the whole reason that
// conditional write exists: two workers finishing their last message
// milliseconds apart both count the same total, exactly one gets `finalized`,
// so exactly one pays for this generation.
describe("the session summary", () => {
  // The two agents on this path use DIFFERENT halves of the Bedrock stub: the
  // Evaluator calls `converseText`, the Session Summarizer calls
  // `converseStructured`. Setting only the text reply leaves the summariser
  // with no behaviour configured, which surfaces as "produced nothing usable"
  // rather than as a failure — the agent returns null on anything it cannot
  // parse, by design.
  const SUMMARY_REPLY = {
    summaryText: "Strong on delivery, thin on systems depth.",
    flaggedExamples: [],
  };

  /** The EVAL# rows `loadSessionEvaluations` reads back. The summariser
   *  returns null on an empty list, so this cannot be a bare score triple. */
  const SCORED_ROW = {
    PK: sessionPk(SESSION_ID),
    SK: `EVAL#${QUESTION_ID}`,
    type: ITEM_TYPE.SESSION_EVALUATION,
    questionId: QUESTION_ID,
    correctness: 7,
    clarity: 6,
    depth: 4,
    rationale: "Named the tradeoff without naming a system they built.",
    modelId: "mistral.ministral-3-8b-instruct",
    evaluatedAt: NOW,
  };

  /** A session whose last answer has just landed: the rollup exists with a
   *  matching questionCount and no averages yet, so this worker wins the
   *  election and goes on to write the history card.
   *
   *  The two GetCommands are matched by sort key rather than answered by one
   *  catch-all, because they read different items for different reasons —
   *  `finalizeIfComplete` reads the rollup, and `putSessionSummary` re-reads
   *  META for the userId the history row is keyed by. Answering both with the
   *  rollup makes the META parse fail, `historyRow` come back undefined, and
   *  the summariser never run — silently, because that failure is caught. */
  function lastAnswerOfSession(): void {
    ddb.on(GetCommand).resolves({});
    ddb
      .on(GetCommand, {
        Key: { PK: sessionPk(SESSION_ID), SK: SORT_KEY.EVAL_SUMMARY },
      })
      .resolves({
        Item: {
          PK: sessionPk(SESSION_ID),
          SK: SORT_KEY.EVAL_SUMMARY,
          type: ITEM_TYPE.SESSION_EVAL_SUMMARY,
          questionCount: 1,
        },
      });
    ddb
      .on(GetCommand, {
        Key: { PK: sessionPk(SESSION_ID), SK: SORT_KEY.META },
      })
      .resolves({ Item: META });
    ddb.on(QueryCommand).resolves({
      Items: [{ correctness: 7, clarity: 6, depth: 4 }],
    });
  }

  it("attaches a summary to the candidate's history row", async () => {
    lastAnswerOfSession();
    // `loadSessionEvaluations` runs two Queries in parallel — the ANSWER# rows
    // and the EVAL# rows — and pairs them by questionId. Answering both with
    // the same item leaves every evaluation without its answer, the view list
    // empty, and the summariser returning null before it ever calls the model.
    ddb.on(QueryCommand).callsFake((input) => {
      const prefix = String(
        (input as { ExpressionAttributeValues?: Record<string, unknown> })
          .ExpressionAttributeValues?.[":prefix"] ?? "",
      );
      if (prefix.startsWith("ANSWER")) return { Items: [ANSWER] };
      return { Items: [SCORED_ROW] };
    });
    setStructuredReplies([SUMMARY_REPLY]);
    queued(JSON.stringify(JOB));

    await pollOnce();

    const summaryWrite = ddb
      .commandCalls(UpdateCommand)
      .map((call) => call.args[0].input)
      .find((input) => String(input.Key?.PK ?? "").startsWith("USER#"));

    // Written onto the history row the Coach reads, not back onto the session.
    expect(summaryWrite?.Key?.PK).toBe(userPk(USER_ID));
    expect(JSON.stringify(summaryWrite?.ExpressionAttributeValues)).toContain(
      "Strong on delivery",
    );
    expect(deletedReceipts()).toEqual(["receipt-0"]);
  });

  // Runs AFTER the session is closed out and its history card written, so a
  // failure costs a paragraph. A throw would redeliver the message, re-run the
  // completion check, and leave the summary to a worker with nothing new to say.
  it("does not fail the message when the summary cannot be produced", async () => {
    lastAnswerOfSession();
    queued(JSON.stringify(JOB));

    // Only the SUMMARY write fails, not the finalisation. They are both
    // UpdateCommands and are told apart by partition: `attachSessionSummary`
    // writes to USER#<uid>, `finalizeIfComplete` to SESSION#<sid>. Failing both
    // would propagate out of handleMessage and leave the message undeleted,
    // which is a different behaviour and already covered above.
    ddb.on(UpdateCommand).callsFake((input) => {
      const pk = String(
        (input as { Key?: Record<string, unknown> }).Key?.PK ?? "",
      );
      if (pk.startsWith("USER#")) throw new Error("history row write failed");
      return {};
    });

    await pollOnce();

    // Still deleted: the evaluation landed, which is what the message was for.
    expect(deletedReceipts()).toEqual(["receipt-0"]);
  });

  it("writes the summary against the user partition, not the session", async () => {
    lastAnswerOfSession();
    queued(JSON.stringify(JOB));

    await pollOnce();

    const userWrites = ddb
      .commandCalls(UpdateCommand)
      .map((call) => String(call.args[0].input.Key?.PK ?? ""))
      .filter((pk) => pk === userPk(USER_ID));

    // A summary keyed to the session would be invisible to the Coach, which
    // reads USER#<uid>/SUMMARY#<completedAt> in one Query.
    for (const pk of userWrites) {
      expect(pk).toBe(userPk(USER_ID));
    }
    expect(userSummarySk(NOW).startsWith("SUMMARY#")).toBe(true);
  });
});
