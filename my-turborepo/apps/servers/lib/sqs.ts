import {
  SendMessageBatchCommand,
  SQSClient,
  type SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";
import { type EvalJob } from "@repo/shared";
import { config } from "./config";
import { SQS } from "./constants";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Every SQS command lives here, matching how lib/dynamo.ts owns the table and
// lib/s3.ts owns object writes. Routes decide status codes; this decides how a
// message is shaped and batched.

export const sqsClient = new SQSClient({ region: config.awsRegion });

// Checked at point of use rather than at boot, matching requireTable(). Only
// the post-interview path needs the queue, and failing startup over it would
// take down auth, /plan and the interview loop itself.
export function requireEvalQueue(): string {
  if (config.evalQueueUrl.length === 0) {
    throw new ServiceError(MESSAGES.EVAL_QUEUE_UNSET);
  }
  return config.evalQueueUrl;
}

// A standard queue, not FIFO, and that is a decision rather than a default.
//
// FIFO's deduplication is producer-side and expires after five minutes, so it
// does not prevent the duplicate that actually occurs here: a worker that
// receives a message, calls Bedrock, and dies before DeleteMessage. The
// visibility timeout expires and SQS redelivers — FIFO included.
//
// What FIFO would add is head-of-line blocking. Messages are grouped, and the
// only natural group is the session, so all fifteen answers from one interview
// would score serially instead of in parallel, and one poison message would
// stall every other answer in that session until it reached the DLQ.
//
// Idempotency is handled where it belongs: EVAL#<questionId> is written with
// PutItem, so a redelivery overwrites the same item rather than creating a
// second one, and completion is derived by querying that prefix rather than
// from a counter that duplicates would corrupt. See data-model.md §1.
export async function enqueueEvaluations(args: {
  sessionId: string;
  questionIds: string[];
}): Promise<number> {
  if (args.questionIds.length === 0) return 0;

  const QueueUrl = requireEvalQueue();
  let queued = 0;

  // SendMessageBatch caps at 10. Like BatchWriteItem's 25, this is a hard
  // limit — sending 11 is a validation error, not a slower request.
  for (
    let start = 0;
    start < args.questionIds.length;
    start += SQS.SEND_BATCH_SIZE
  ) {
    const chunk = args.questionIds.slice(start, start + SQS.SEND_BATCH_SIZE);

    const Entries: SendMessageBatchRequestEntry[] = chunk.map(
      (questionId, index) => {
        const job: EvalJob = { sessionId: args.sessionId, questionId };
        return {
          // Batch-local only — SQS requires uniqueness within the request, not
          // across requests, and it is not a deduplication id on a standard
          // queue. The questionId is already unique per session, so it doubles
          // as a readable handle in an error response.
          Id: `${start + index}`,
          MessageBody: JSON.stringify(job),
        };
      }
    );

    let response;
    try {
      response = await sqsClient.send(
        new SendMessageBatchCommand({ QueueUrl, Entries })
      );
    } catch (error) {
      throw new ServiceError(
        `${MESSAGES.EVAL_ENQUEUE_FAILED} — ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    // SendMessageBatch reports per-entry failures in the response rather than
    // by throwing, so a batch can "succeed" having queued nothing. Left
    // unchecked, that is an interview whose answers are never scored and whose
    // results page waits forever with no error anywhere.
    const failed = response.Failed ?? [];
    if (failed.length > 0) {
      throw new ServiceError(
        `${MESSAGES.EVAL_ENQUEUE_FAILED} — ${failed.length} of ${Entries.length} rejected: ${failed
          .map((entry) => `${entry.Id}:${entry.Code ?? "unknown"}`)
          .join(", ")}`
      );
    }

    queued += response.Successful?.length ?? 0;
  }

  return queued;
}
