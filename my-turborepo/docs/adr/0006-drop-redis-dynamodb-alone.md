# ADR-0006: Drop ElastiCache Redis; DynamoDB alone

- **Status:** Accepted
- **Date:** 2026-09-09
- **Supersedes:** [ADR-0003](0003-redis-hot-state-dynamodb-durable.md) in full.

## Context

ADR-0003 split state by lifetime: ElastiCache Redis for ephemeral per-turn
state (question index, turn count, rate-limit counters), DynamoDB for the
durable record. It was accepted before the voice loop was built.

The loop then got built, and two of that decision's three premises turned out
not to hold.

**There is no per-turn server call to optimise.** ADR-0003 justified Redis on
latency inside a 1.6–2.0s turn budget. That budget assumed a request/response
turn: transcribe, call a model, synthesise. Nova 2 Sonic replaced that with one
long-lived bidirectional stream ([ADR-0005](0005_nova_sonic_speech_to_speech.md)),
so the server is not in the loop between the candidate speaking and the
interviewer answering. There is no read to make fast.

**The state Redis was to hold has two homes already.** Turn count and question
index live in the Sonic session's own in-process state for the duration of a
stream, and the transcript has to reach DynamoDB regardless — it is the
Evaluator's and the Coach's only input. A Redis copy would have been a third
representation of facts that were already written twice.

This was discovered during implementation and recorded only in a phase tracker.
ADR-0003 stayed marked **Accepted** for roughly a month while describing
infrastructure that was never provisioned, and `docs/architecture/data-model.md`
documented its key layout for just as long. A reader asking "why do we run
Redis?" would have been answered confidently and wrongly by the repository's own
records. That is the failure this ADR exists to close, as much as the technical
one.

## Decision

**One durable store: DynamoDB. No cache tier.**

No `elasticache` module, no `ioredis`, no `lib/redis.ts`. Session state is held
in the Sonic session object while a stream is open and in DynamoDB once an
exchange completes.

## Consequences

**One failure mode instead of two.** ADR-0003 accepted that Redis being
unavailable had to degrade gracefully. That branch no longer exists.

**No always-on cost.** ElastiCache bills per hour whether or not anyone
interviews. ADR-0003 named this as the first thing to reconsider under cost
pressure; it turned out to be the first thing to reconsider under scrutiny of
any kind.

**Rate limiting lost its intended destination.** ADR-0003 justified Redis partly
on `INCR` + `EXPIRE` being a natural fit. `apps/servers/lib/rateLimit.ts` is
still an in-memory store, so the budget is per ECS task: at N tasks the
effective limit is `limit × N`. Unresolved. The options are an accepted
per-task budget with the limit divided by the maximum task count, a
DynamoDB-backed counter, or ALB/WAF rate-based rules — which key on IP rather
than on the Cognito subject the limiter uses today.

**Interview audio is not stored either.** Related but separate: audio streams
through the WebSocket and is discarded. The `audio/` S3 prefix, its lifecycle
rule and the `audioKey` attribute were removed rather than left as scaffolding
for a feature nobody had committed to.

## Rejected: keep Redis for rate limiting alone

A cluster whose only job is a counter that fires a few times per candidate per
minute. It reintroduces the always-on cost and the VPC-attached component to
solve a problem that a DynamoDB conditional update or an ALB rule also solves,
neither of which is a new piece of infrastructure.
