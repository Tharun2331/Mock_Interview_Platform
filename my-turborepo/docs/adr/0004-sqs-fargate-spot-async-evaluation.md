# ADR-0004: SQS + Fargate Spot for asynchronous evaluation

- **Status:** Accepted, with the completion counter amended
- **Date:** 2026-08-11
- **Amended:** 2026-09-09 — the counter below was replaced by a derived count,
  and the rollup item moved off the `EVAL#` prefix. See "Idempotency".

## Context

After an interview round, each answer needs scoring on correctness, clarity,
and depth. That's one Bedrock call per question, and a 15-question round means
15 calls. The candidate is looking at a summary screen and isn't waiting on any
single one of them.

## Decision

Express enqueues each answer to an SQS `eval-queue` and returns immediately. A
second ECS Fargate service running on **Spot capacity** consumes the queue,
scores each answer with Bedrock, and writes results to DynamoDB. Messages that
fail beyond `maxReceiveCount: 3` land in a dead-letter queue.

Completion is derived by counting `EVAL#<qId>` items, not by maintaining a
counter. When the count reaches the question count, the worker triggers the
Coach agent. (This ADR originally specified `ADD completedCount 1` on
`EVAL#SUMMARY`; see "Idempotency" for why that was dropped.)

## Why Spot is safe here

SQS's visibility-timeout mechanism makes Spot reclamation a non-event. If a
task is interrupted mid-message, the message becomes visible again and another
consumer picks it up. There is no partial state to reconcile because each
message is scored independently.

Spot cuts worker compute by roughly 70%. Being honest about the size of that
win: **the dominant cost here is Bedrock inference tokens, not worker compute**,
so the saving lands on the smaller line item. It's still worth doing — it
demonstrates a resilient, cost-aware batch pattern, and more importantly it
gives the evaluator its own IAM role scoped to `bedrock:InvokeModel` plus
DynamoDB write on `EVAL#` items only.

## Idempotency

SQS is at-least-once delivery, so a message can be redelivered after a
successful write. Evaluations are keyed by `questionId` and written with
`PutItem`, so a redelivery overwrites the same item rather than double-counting.

The completion counter was the exception, and it is why there is no longer
one. `ADD completedCount 1` is not idempotent, so a redelivery over-counts and
fires the Coach early — on an interview still being scored. Completion is
derived from `Query ... begins_with("EVAL#")` instead, which is exact by
construction and also removes a hot single-item write from every evaluation.

That change has a second consequence, found before the worker was built. The
rollup item sat at `EVAL#SUMMARY`, **inside the range that query returns**, so
it would have counted as an evaluation and fired the Coach one question early
anyway. Its sort key is now `SUMMARY`.

## Rejected: synchronous scoring in the request path

Scoring 15 answers inline would add tens of seconds to the round-end response,
with no upside — nothing downstream needs the scores immediately.

## Rejected: Lambda for the worker

Lambda would fit the shape and remove a service. It was rejected to keep one
runtime and one deployment story across the project — the worker shares agent
code with the main Express service, and a second packaging path for the same
TypeScript is friction that buys little at this scale.

## Consequences

- A second ECS service, task definition, and IAM role to maintain in Terraform.
- The DLQ needs a CloudWatch alarm, or failures accumulate silently.
- Results arrive asynchronously, so the client polls or reconnects for the final
  result rather than receiving it in a response.