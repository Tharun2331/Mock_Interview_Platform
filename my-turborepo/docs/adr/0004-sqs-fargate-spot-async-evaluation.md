# ADR-0004: SQS + Fargate Spot for asynchronous evaluation

**Status:** Accepted · **Date:** 2026-08-11

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

A completion counter (`UpdateItem` with `ADD completedCount 1` on
`EVAL#SUMMARY`) tracks progress. When it reaches the question count, the worker
triggers the Coach agent.

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

The completion counter is the exception — `ADD completedCount 1` is not
idempotent, and a redelivery would over-count. Guard it with a conditional
write on the `EVAL#<qId>` item not already existing, or derive completion by
counting `EVAL#` items instead of maintaining a counter.

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