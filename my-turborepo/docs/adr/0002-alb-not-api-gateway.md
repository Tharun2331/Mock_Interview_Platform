# ADR-0002: ALB, not API Gateway

**Status:** Accepted · **Date:** 2026-08-11

## Context

The interview loop requires bidirectional WebSocket transport (ADR-0001) to an
Express service running on ECS Fargate in private subnets. Something has to
terminate TLS and route traffic into the VPC.

## Decision

Use an **Application Load Balancer** with a listener rule forwarding to the
Fargate service target group.

## Rejected: API Gateway

API Gateway would require a **separate WebSocket API** — HTTP APIs and
WebSocket APIs are distinct resource types with different routing models — plus
a **VPC Link** to reach a service in private subnets. That's two additional
components, an extra network hop, and a second routing configuration to keep in
sync with the first, in exchange for nothing this application uses.

API Gateway's genuine advantages — usage plans, API keys, request/response
transformation, per-route throttling — are all things we either don't need or
already handle in Express. Rate limiting lives in Redis, keyed by Cognito
subject, because it needs to be per-user rather than per-source-IP.

ALB terminates WebSocket natively as an HTTP-family listener rule. The upgrade
handshake passes through and the connection stays open. One component, one
config.

## Consequences

- ALB bills hourly plus per LCU, so it's an always-on cost like NAT Gateway.
  During scaffold weeks with no running tasks, it's waste.
- Idle timeout defaults to 60 seconds and must be raised — a candidate thinking
  through an answer produces no traffic, and the default would drop the
  connection mid-interview.
- No built-in request validation, so Zod validation at the Express boundary is
  load-bearing rather than a second line of defence.
- Health checks need a plain HTTP endpoint (`GET /health`) alongside the
  WebSocket route.