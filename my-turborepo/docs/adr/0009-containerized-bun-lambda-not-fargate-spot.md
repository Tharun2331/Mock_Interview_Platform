# ADR-0009: A containerized Bun Lambda, not Fargate Spot, for the Evaluator worker

- **Status:** Accepted
- **Date:** 2026-10-01
- **Supersedes:** [ADR-0004](0004-sqs-fargate-spot-async-evaluation.md) in full.

## Context

ADR-0004 chose Fargate Spot for the Evaluator worker and rejected Lambda explicitly, on the grounds that a second packaging path for the same TypeScript was friction bought for little, when the main API was also going to be an ECS Fargate service sharing the same runtime and deployment story.

[ADR-0008](0008-cloudfront-private-ec2-not-alb-ecs.md) moves the main API off ECS entirely, onto a single EC2 instance. That removes the premise ADR-0004's rejection of Lambda rested on: there is no other ECS service left in this stack for a Fargate worker to share tooling or a deployment pattern with. A standalone Fargate Spot service kept purely for the worker would now be the one piece of the stack still needing a cluster, a task definition, and Spot-capacity handling that nothing else here uses — the opposite of what "one deployment story" was arguing for.

## Decision

The Evaluator worker runs as a **container-image AWS Lambda function running Bun**, triggered directly by the eval SQS queue's event-source mapping. Bun has no native Lambda runtime, so the function is packaged as a Docker image (`FROM oven/bun` or equivalent) and pushed to ECR — not rewritten in Node, which would break the project's locked-in Bun choice without explicit sign-off.

## Why this now beats Fargate Spot

**It keeps exactly the property ADR-0004 valued, for less.** ADR-0004's strongest argument for Fargate over the request-path alternative was giving the evaluator its own IAM role, scoped to `bedrock:InvokeModel` and nothing more — specifically so a compromised or looped worker could never open the billable, bidirectional Sonic stream the main API's role can. A Lambda function gets its own execution role automatically, with no shared instance profile and no `sts:AssumeRole` engineering needed to get there. The separation ADR-0004 built Fargate partly to achieve is Lambda's default.

**It has no idle cost and nothing to size.** A Fargate Spot task bills for however long it runs, whether or not a message is waiting. Lambda bills per invocation and duration, and this project's evaluation volume — a handful of calls per finished interview — sits comfortably inside the free tier.

**It needs no VPC attachment, so it shares no failure domain with the NAT instance ADR-0008 introduces.** Bedrock, DynamoDB, and SQS are all reachable from an unattached Lambda over AWS's own network. The worker never calls the public internet — only the main API's GitHub call does — so its uptime is independent of the NAT instance entirely.

**It removes code, not just relocates it.** `worker.ts` and `workerLoop.ts` hand-roll the long-poll loop, the receive batching, and visibility-timeout bookkeeping that Lambda's SQS event-source mapping already does. What's left after the move is close to the Evaluator agent logic (`agents/evaluator.ts`) behind a thin handler.

## Rejected: keep Fargate Spot as its own standalone ECS service

Workable, but it means standing up and maintaining a cluster, a task definition, and Spot-capacity handling for exactly one service, once ADR-0008 has already moved everything else off ECS. ADR-0004's own "one deployment story" reasoning now argues against this, not for it.

## Rejected: colocate the worker as a second process on the EC2 instance

Both processes would share the instance's one IAM instance profile by default, undoing the role separation ADR-0004 built Fargate specifically to get — unless each process separately assumes a narrower role via STS, which is real extra engineering that ECS and Lambda both provide for free. Rejected on the same grounds ADR-0004 originally argued for the separation in the first place.

## Rejected: rewrite the worker in Node for Lambda's native runtime

Breaks the project's locked Bun decision without being asked to. The container-image path keeps Bun throughout the stack at the cost of one Dockerfile.

## Consequences

- **Packaging Bun for Lambda is a real build step**, not zero-friction — a Dockerfile and an ECR repository, not pointing Lambda at `worker.ts` directly.
- **The existing DLQ and its redrive policy (`maxReceiveCount`) carry over unchanged** — that's a property of the queue, not the consumer, so nothing about failure handling changes.
- **Logging needs revisiting.** Lambda's default log group is `/aws/lambda/<function-name>`, not the `/prepilot/<env>/worker` group the `cloudwatch` module's alarms and EMF metric extraction already target. Either the function's logging config is pointed at the existing group, or the `cloudwatch` module's `worker_log_group` wiring is updated to match. Not yet decided.
- **`WORKER.RECEIVE_BATCH_SIZE` and `WORKER.LONG_POLL_SECONDS` in `apps/servers/lib/constants.ts` stop applying** once the event-source mapping owns polling and batching; `WORKER.VISIBILITY_TIMEOUT_SECONDS` still matters, since that's enforced by SQS regardless of consumer. Cleaning up the now-dead constants is a task for when this is actually built, not before.
