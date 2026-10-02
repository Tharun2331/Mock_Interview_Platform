import { handleMessage } from "./worker";

// The Evaluator as a Lambda function (ADR-0009). A third entrypoint into the
// same codebase, after index.ts (the API) and worker.ts (the local poller).
//
// Lambda's SQS event-source mapping now does what worker.ts's loop hand-rolls:
// polling, batching, visibility. What is left is the decision that loop made per
// message, unchanged, because it is `handleMessage` itself:
//
//   returned  -> finished with, including duplicates, answers with nothing to
//                score and malformed bodies. SQS deletes it.
//   threw     -> a failure a retry could fix (Bedrock exhausted, DynamoDB
//                down). Reported as a batch item failure, so SQS redelivers
//                that message alone after the visibility timeout, and
//                maxReceiveCount routes it to the DLQ if it keeps failing.
//
// Reporting failures per message rather than throwing for the batch is what
// stops one bad answer from re-running every other answer it arrived with — and
// paying for their generations again.

// The subset of Lambda's SQS event this reads.
export type SqsEvent = {
  Records: Array<{ messageId: string; body: string }>;
};

export type SqsBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

export async function handleSqsEvent(event: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: SqsBatchResponse["batchItemFailures"] = [];

  // Sequential, as in worker.ts. Concurrency is bounded where it can be seen
  // and capped — the event-source mapping's maximum_concurrency — not inside
  // one invocation, where it would multiply Bedrock spend with no ceiling.
  for (const record of event.Records) {
    try {
      const outcome = await handleMessage(record.body);

      if (outcome.kind === "unparseable") {
        console.error(`[evaluator] dropping unparseable message ${record.messageId}`);
      } else if (outcome.kind === "scored") {
        console.log(
          `[evaluator] scored ${outcome.questionId} with ${outcome.modelId} (${outcome.finalized})`,
        );
      } else {
        console.log(
          `[evaluator] ${outcome.kind} ${outcome.questionId} (${outcome.finalized})`,
        );
      }
    } catch (error) {
      console.error(
        `[evaluator] scoring failed, leaving ${record.messageId} for redelivery — ${
          error instanceof Error ? error.message : error
        }`,
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

// ---------------------------------------------------------------------------
// The runtime loop.
//
// Bun has no managed Lambda runtime, so this process IS the runtime: the image
// runs it as /var/runtime/bootstrap, and it speaks Lambda's Runtime API
// directly — fetch the next event, hand back its result, repeat. It is the
// whole contract a custom runtime has to meet:
// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
//
// Guarded so importing this module in a test does not start polling.
// ---------------------------------------------------------------------------
async function runtimeLoop(): Promise<never> {
  const api = `http://${process.env.AWS_LAMBDA_RUNTIME_API}/2018-06-01/runtime`;

  while (true) {
    const next = await fetch(`${api}/invocation/next`);
    const requestId = next.headers.get("lambda-runtime-aws-request-id") ?? "";

    try {
      const event = (await next.json()) as SqsEvent;
      const result = await handleSqsEvent(event);
      await fetch(`${api}/invocation/${requestId}/response`, {
        method: "POST",
        body: JSON.stringify(result),
      });
    } catch (error) {
      // handleSqsEvent catches per message, so this is an unreadable event or
      // a bug. Failing the invocation makes SQS retry the whole batch, which is
      // the safe direction: nothing was confirmed as done.
      console.error("[evaluator] invocation failed", error);
      await fetch(`${api}/invocation/${requestId}/error`, {
        method: "POST",
        body: JSON.stringify({
          errorType: error instanceof Error ? error.name : "Error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
}

if (import.meta.main) {
  await runtimeLoop();
}
