# ADR-0003: Redis for hot state, DynamoDB for durable state

**Status:** Accepted · **Date:** 2026-08-11

## Context

An interview session produces two kinds of data with very different lifetimes:
per-turn counters that change every few seconds and are worthless after the
session ends, and the transcript and scores that are the entire product.

## Decision

Two stores, split by data lifetime.

**ElastiCache Redis** holds ephemeral, high-frequency state: current question
index, turn count, and rate-limit counters (`INCR` + `EXPIRE`). Session state
carries a 2-hour TTL. Nothing in Redis needs backup — every key is either
rebuildable from DynamoDB or safe to discard.

**DynamoDB** holds the permanent record: session metadata, the Q&A transcript,
evaluation scores, and the coach plan. Single-table design, keyed
`SESSION#<sid>` so one `Query` returns a whole session.

## Rejected: Cognito for session state

Cognito user attributes are not built for this write frequency, and the
attribute size limits don't fit the data shape. Cognito mints identity; it is
not a database.

## Rejected: DynamoDB alone

Writing turn counters to DynamoDB on every turn would work and would remove a
component. It was rejected for latency inside the 1.6–2.0s turn budget, and
because rate limiting via `INCR` is a natural Redis operation and an awkward
DynamoDB one (conditional update with a TTL attribute, and TTL deletion is
best-effort with no timing guarantee).

The honest counterweight: ElastiCache is an always-on cost for a workload with
no traffic yet. If cost pressure appears before the interview loop ships,
collapsing to DynamoDB-only is the first thing to reconsider.

## Consequences

- Two failure modes instead of one. Redis being unavailable must degrade
  gracefully rather than fail the interview — state can be rebuilt from
  DynamoDB.
- The split has to be enforced by discipline. Anything written only to Redis is
  lost on task restart, so the rule is: if losing it would break the product,
  it goes to DynamoDB first.
- Redis lives in private subnets and is reached via security group, never a
  public endpoint.