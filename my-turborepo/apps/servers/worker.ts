import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { EvalJobSchema } from "@repo/shared";
import { runEvaluator } from "./agents/evaluator";
import { WORKER } from "./lib/constants";
import {
  finalizeIfComplete,
  loadEvaluationJob,
  putEvaluation,
} from "./lib/evaluations";
import { requireEvalQueue, sqsClient } from "./lib/sqs";

// The Evaluator worker. A second entrypoint into the same codebase as the API,
// not a second codebase.
//
// It needs lib/dynamo, lib/bedrock, lib/config, lib/errors and lib/messages —
// duplicating those into a separate workspace would buy nothing, because the
// isolation that actually matters is the IAM task role, and that is attached
// per ECS task definition rather than per repository. Same image, different
// command, different role: `bedrock:InvokeModel` plus DynamoDB writes scoped to
// EVAL# items, and never the API's role.
//
// The fallback chain is switched off here by configuration, not by code. The
// task definition sets BEDROCK_TEXT_MODEL_IDS to a single id, because SQS
// redrive already provides retries — walking three models is a slower, second
// retry mechanism whose latency can outlive the queue's visibility timeout, and
// a message redelivered mid-flight pays for a second generation.

export type MessageOutcome =
  | {
      kind: "scored";
      questionId: string;
      modelId: string;
      // What the completion check concluded after this score landed.
      finalized: "incomplete" | "finalized" | "already-finalized" | "no-summary";
    }
  | { kind: "already-scored"; questionId: string }
  | { kind: "no-answer"; questionId: string }
  // The body was not a valid job. Retrying cannot fix a malformed message, so
  // it is deleted rather than left to cycle to the DLQ three receives later.
  | { kind: "unparseable" };

// One message, start to finish. Separate from the loop so it can be tested
// without standing up a poller.
//
// Throws only on failures a retry could plausibly fix — a DynamoDB outage, an
// exhausted Bedrock chain. The caller leaves those messages undeleted so SQS
// redelivers them, and `maxReceiveCount` eventually routes them to the DLQ.
export async function handleMessage(body: string): Promise<MessageOutcome> {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return { kind: "unparseable" };
  }

  const job = EvalJobSchema.safeParse(parsedBody);
  if (!job.success) return { kind: "unparseable" };

  const { sessionId, questionId } = job.data;
  const state = await loadEvaluationJob({ sessionId, questionId });

  // The duplicate guard. A redelivered message costs one strongly consistent
  // read instead of a full generation — the real version of the protection a
  // FIFO queue only appears to offer.
  if (state.kind === "already-scored") return { kind: "already-scored", questionId };
  if (state.kind === "no-answer") return { kind: "no-answer", questionId };

  const result = await runEvaluator(state.input);

  await putEvaluation({
    sessionId,
    questionId,
    correctness: result.correctness,
    clarity: result.clarity,
    depth: result.depth,
    rationale: result.rationale,
    modelId: result.modelId,
  });

  // Was that the last one? Runs after every score rather than being scheduled,
  // because there is no other trigger — the queue going empty is not an event
  // anything observes.
  //
  // Deliberately inside the same message. If it threw, the message would be
  // redelivered and re-scored, which is wasteful but harmless: the duplicate
  // guard catches the re-score and the check runs again. Swallowing it instead
  // would leave a finished session parked at `evaluating` with nothing left in
  // the queue to ever look again.
  const finalized = await finalizeIfComplete({ sessionId });

  return {
    kind: "scored",
    questionId,
    modelId: result.modelId,
    finalized: finalized.kind,
  };
}

async function processMessage(message: Message, QueueUrl: string): Promise<void> {
  const { Body, ReceiptHandle } = message;
  if (Body === undefined || ReceiptHandle === undefined) return;

  let outcome: MessageOutcome;
  try {
    outcome = await handleMessage(Body);
  } catch (error) {
    // Left undeleted on purpose. The visibility timeout returns it to the queue
    // and `maxReceiveCount` routes it to the DLQ if it keeps failing, which is
    // the retry the Evaluator relies on instead of a model fallback chain.
    console.error(
      `[worker] scoring failed, leaving for redelivery — ${
        error instanceof Error ? error.message : error
      }`
    );
    return;
  }

  if (outcome.kind === "unparseable") {
    // A retry cannot fix a malformed body, so cycling it to the DLQ three
    // receives later only delays the same conclusion.
    console.error("[worker] dropping unparseable message");
  } else if (outcome.kind === "scored") {
    console.log(
      `[worker] scored ${outcome.questionId} with ${outcome.modelId} (${outcome.finalized})`
    );
  } else {
    console.log(`[worker] ${outcome.kind} ${outcome.questionId}`);
  }

  // Every outcome that reaches here is finished with, including the ones that
  // did no work: leaving a message undeleted is a request for redelivery, and
  // neither a duplicate, a missing answer nor a malformed body improves on a
  // retry. Failures that a retry could fix threw above and returned early.
  await sqsClient.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle }));
}

// Long-polls the queue until the process is asked to stop.
export async function runWorker(shouldStop: () => boolean): Promise<void> {
  const QueueUrl = requireEvalQueue();
  console.log("[worker] polling for answers to score");

  while (!shouldStop()) {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: WORKER.RECEIVE_BATCH_SIZE,
        // Long polling. Without it an idle worker bills a request every few
        // milliseconds and returns nothing; with it, one request waits.
        WaitTimeSeconds: WORKER.LONG_POLL_SECONDS,
        // Must comfortably exceed one Bedrock call, or the message is
        // redelivered while the first attempt is still running and the second
        // generation is paid for twice. This is the number that makes the
        // single-model configuration matter.
        VisibilityTimeout: WORKER.VISIBILITY_TIMEOUT_SECONDS,
      })
    );

    const messages = response.Messages ?? [];

    // Sequential rather than parallel. Fargate Spot tasks are small, and
    // scaling is horizontal — another task — rather than by fanning out inside
    // one. Concurrency here would multiply Bedrock spend per task with no
    // control over the total.
    for (const message of messages) {
      if (shouldStop()) break;
      await processMessage(message, QueueUrl);
    }
  }

  console.log("[worker] stopped");
}

// Only when run directly, so importing this module in a test does not start a
// poll loop.
if (import.meta.main) {
  let stopping = false;
  // SIGTERM is how ECS asks a task to end, and how Spot announces a
  // reclamation. Finishing the message in flight and then exiting means its
  // work is not repeated by whoever picks it up next.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, finishing current message`);
      stopping = true;
    });
  }

  await runWorker(() => stopping);
}
