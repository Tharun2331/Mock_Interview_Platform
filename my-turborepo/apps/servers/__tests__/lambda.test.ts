import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { resetBedrockStub, resetStructuredStub } from "./helpers/bedrockStub";

// The Lambda handler adds one decision on top of `handleMessage` (covered in
// worker.test.ts): which records of a batch SQS should redeliver. Exercised
// through the edges — a malformed body, a DynamoDB outage — rather than by
// mocking ../worker, which worker.test.ts is the subject of (see the stub's
// header for what a module mock does to the file that tests it).
const { handleSqsEvent } = await import("../lambda");

const ddb = mockClient(DynamoDBDocumentClient);

const VALID_JOB = JSON.stringify({
  sessionId: "01J000000000000000000000",
  questionId: "q1",
});

function record(messageId: string, body: string) {
  return { messageId, body };
}

beforeEach(() => {
  ddb.reset();
  resetBedrockStub();
  resetStructuredStub();
});

afterAll(() => ddb.restore());

describe("which records SQS redelivers", () => {
  // A retry cannot fix a malformed body, so it is finished with — deleted, not
  // cycled to the DLQ three receives later.
  it("does not report a message that was handled, even one that did nothing", async () => {
    const result = await handleSqsEvent({
      Records: [record("m1", "not json")],
    });

    expect(result.batchItemFailures).toEqual([]);
  });

  // A failure a retry could plausibly fix is reported, so SQS returns it to the
  // queue after the visibility timeout and maxReceiveCount bounds the retries.
  it("reports a message whose scoring threw", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    const result = await handleSqsEvent({ Records: [record("m1", VALID_JOB)] });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
  });

  // The point of partial batch responses: one bad answer must not re-run, and
  // re-pay for, every other answer that arrived in the same batch.
  it("reports only the failing record of a mixed batch", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    const result = await handleSqsEvent({
      Records: [record("done", "not json"), record("failed", VALID_JOB)],
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "failed" }]);
  });

  it("keeps going after a failure rather than abandoning the batch", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    const result = await handleSqsEvent({
      Records: [record("a", VALID_JOB), record("b", VALID_JOB)],
    });

    expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("recognising the final attempt", () => {
  it("is the delivery that reaches the queue's receive limit", async () => {
    const { isFinalAttempt } = await import("../lambda");

    expect(isFinalAttempt("3", 3)).toBe(true);
    expect(isFinalAttempt("4", 3)).toBe(true);
    expect(isFinalAttempt("2", 3)).toBe(false);
    expect(isFinalAttempt("1", 3)).toBe(false);
  });

  // Retrying once more is the safe direction when the count is unreadable.
  it("is never assumed when the count is missing or garbage", async () => {
    const { isFinalAttempt } = await import("../lambda");

    expect(isFinalAttempt(undefined, 3)).toBe(false);
    expect(isFinalAttempt("not a number", 3)).toBe(false);
  });
});
