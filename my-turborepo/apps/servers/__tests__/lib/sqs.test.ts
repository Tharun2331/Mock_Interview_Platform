import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { EvalJobSchema } from "@repo/shared";
import { SQS } from "../../lib/constants";
import { ServiceError } from "../../lib/errors";
import { enqueueEvaluations, requireEvalQueue } from "../../lib/sqs";

const sqs = mockClient(SQSClient);

function ids(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `q${index}`);
}

function entriesOf(callIndex: number) {
  return sqs.commandCalls(SendMessageBatchCommand)[callIndex]?.args[0].input
    .Entries ?? [];
}

beforeEach(() => sqs.reset());
afterAll(() => sqs.restore());

describe("requireEvalQueue", () => {
  // Checked at point of use rather than at boot: only the post-interview path
  // needs the queue, and failing startup over it would take down auth, /plan
  // and the interview loop itself.
  it("returns the configured queue url", () => {
    expect(requireEvalQueue()).toContain("prepilot-eval-test");
  });
});

describe("enqueueEvaluations", () => {
  it("sends one message per answer", async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: ids(3).map((_unused, index) => ({
        Id: String(index),
        MessageId: `m${index}`,
        MD5OfMessageBody: "x",
      })),
    });

    const queued = await enqueueEvaluations({
      sessionId: "session-1",
      questionIds: ids(3),
    });

    expect(queued).toBe(3);
    expect(entriesOf(0)).toHaveLength(3);
  });

  // A pointer, not a payload. The worker reads the answer when it scores it, so
  // a message can never carry a stale copy — and an erasure sweep cannot reach
  // into a queue to delete a transcript it never put there.
  it("sends a pointer carrying no transcript", async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "m", MD5OfMessageBody: "x" }],
    });

    await enqueueEvaluations({ sessionId: "session-1", questionIds: ["q1"] });

    const body: unknown = JSON.parse(entriesOf(0)[0]?.MessageBody ?? "{}");
    // Parsed through the shared contract, so a shape change breaks here rather
    // than in the worker.
    expect(EvalJobSchema.parse(body)).toEqual({
      sessionId: "session-1",
      questionId: "q1",
    });
  });

  // SendMessageBatch caps at 10. Sending 11 is a validation error, not a slower
  // request — the same shape as BatchWriteItem's 25.
  it("chunks at the batch cap", async () => {
    sqs.on(SendMessageBatchCommand).callsFake((input) => ({
      Successful: (input.Entries ?? []).map((entry: { Id: string }) => ({
        Id: entry.Id,
        MessageId: entry.Id,
        MD5OfMessageBody: "x",
      })),
    }));

    // A 15-question round is the documented worst case.
    const queued = await enqueueEvaluations({
      sessionId: "session-1",
      questionIds: ids(15),
    });

    expect(queued).toBe(15);
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
    expect(entriesOf(0)).toHaveLength(SQS.SEND_BATCH_SIZE);
    expect(entriesOf(1)).toHaveLength(5);
  });

  it("gives every entry in a batch a distinct id", async () => {
    sqs.on(SendMessageBatchCommand).callsFake((input) => ({
      Successful: (input.Entries ?? []).map((entry: { Id: string }) => ({
        Id: entry.Id,
        MessageId: entry.Id,
        MD5OfMessageBody: "x",
      })),
    }));

    await enqueueEvaluations({ sessionId: "session-1", questionIds: ids(15) });

    for (const call of sqs.commandCalls(SendMessageBatchCommand)) {
      const batch = call.args[0].input.Entries ?? [];
      const seen = new Set(batch.map((entry) => entry.Id));
      // SQS requires uniqueness within a request, and rejects the whole batch
      // otherwise.
      expect(seen.size).toBe(batch.length);
    }
  });

  it("sends nothing at all for an interview with no answers", async () => {
    const queued = await enqueueEvaluations({
      sessionId: "session-1",
      questionIds: [],
    });

    expect(queued).toBe(0);
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  // SendMessageBatch reports per-entry failures in the response rather than by
  // throwing, so a batch can "succeed" having queued nothing. Unchecked, that
  // is an interview whose answers are never scored and a results page that
  // waits forever with no error anywhere.
  it("treats partial rejection as a failure rather than a success", async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "m0", MD5OfMessageBody: "x" }],
      Failed: [
        {
          Id: "1",
          Code: "InternalError",
          SenderFault: false,
          Message: "transient",
        },
      ],
    });

    await expect(
      enqueueEvaluations({ sessionId: "session-1", questionIds: ids(2) })
    ).rejects.toThrow(ServiceError);
  });

  it("names how many were rejected and why", async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Failed: [
        { Id: "0", Code: "InternalError", SenderFault: false },
        { Id: "1", Code: "InternalError", SenderFault: false },
      ],
    });

    await expect(
      enqueueEvaluations({ sessionId: "session-1", questionIds: ids(2) })
    ).rejects.toThrow(/2 of 2 rejected/);
  });

  it("wraps a transport failure as a ServiceError", async () => {
    sqs.on(SendMessageBatchCommand).rejects(new Error("throttled"));

    await expect(
      enqueueEvaluations({ sessionId: "session-1", questionIds: ids(1) })
    ).rejects.toThrow(ServiceError);
  });

  it("targets the configured queue", async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: "0", MessageId: "m", MD5OfMessageBody: "x" }],
    });

    await enqueueEvaluations({ sessionId: "session-1", questionIds: ["q1"] });

    expect(
      sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.QueueUrl
    ).toBe(requireEvalQueue());
  });
});
