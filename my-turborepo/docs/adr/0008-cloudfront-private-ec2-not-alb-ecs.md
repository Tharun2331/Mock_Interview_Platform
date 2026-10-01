# ADR-0008: CloudFront + a private EC2 instance, not ALB + ECS

- **Status:** Accepted
- **Date:** 2026-10-01
- **Supersedes:** [ADR-0002](0002-alb-not-api-gateway.md) in full.

## Context

ADR-0002 chose an ALB in front of ECS Fargate and was never built — `environments/prod` has stayed empty since. Picking this back up, the ALB and the NAT Gateway its private-subnet Fargate tasks would need turned out to carry a combined fixed cost neither ADR-0002 nor `infra/terraform/CLAUDE.md`'s own cost notes had priced precisely: at current us-east-1 rates, a NAT Gateway is $0.045/hr + $0.045/GB processed (≈$33/month before any data), and an ALB or NLB is $0.0225/hr base (≈$17-20/month before usage). Both are costs that exist whether or not anyone is using the app, which is exactly the failure mode `infra/terraform/CLAUDE.md` already calls out for the NAT Gateway specifically.

A newer AWS feature changes what's possible here: CloudFront VPC origins, [extended to support WebSocket traffic in May 2026](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-cloudfront-websockets-vpc-origins/), let CloudFront reach directly into a VPC and target an EC2 instance in a fully private subnet — no public IP, no inbound internet exposure — over AWS's own network path. The frontend already sits behind CloudFront; this lets the backend use the same edge.

## Decision

CloudFront stays the single internet-facing edge for both the frontend and the API. The backend (the Express service and the interview WebSocket) runs on **one EC2 instance in a private subnet**, reached by CloudFront's VPC origin. No ALB, no NAT Gateway.

Outbound internet access for the backend's own calls — GitHub's API for repo scraping is the only one that isn't an AWS service — goes through a small **NAT instance** in a public subnet, not a managed NAT Gateway.

## Why this beats ALB + ECS

The fixed cost isn't a wrong default that a cleverer combination routes around — it's the price of the one thing ECS's dynamic task placement actually needs: something that tracks a changing IP and routes to the current one. Every AWS-managed way to do that carries its own non-zero floor.

**NLB instead of ALB doesn't close the gap.** Both charge the identical $0.0225/hr base rate in us-east-1; NLB's advantage is a lower per-usage LCU rate (~25% cheaper on bandwidth-heavy traffic), not a lower floor.

**CloudFront can't target a raw ECS task either way.** VPC origins support an ALB, an NLB, or an EC2 instance — never a bare task. Each ECS task replacement gets a new ENI and a new IP; nothing is stable enough to route to without a load balancer in front of it. There is no way to keep ECS's placement model and skip the load balancer.

## Rejected: API Gateway WebSocket + ECS

API Gateway's WebSocket API terminates the connection itself rather than holding a live bidirectional socket open to a backend. A client's messages arrive as separate invocations, and sending anything back to the client means an asynchronous POST through a separate `@connections` API — a fundamentally different model from the one `routes/interview.ts` is built around, where one process holds the socket and streams binary PCM continuously in both directions with sub-second interruption latency. Adopting it would mean rewriting the WebSocket handling layer, not swapping infrastructure under unchanged code — which is exactly what ADR-0002 already ruled out API Gateway for.

It also isn't obviously cheaper. Pricing is $1 per million messages plus $0.25 per million connection-minutes, and the browser's AudioWorklet posts a frame roughly every 32ms per direction (`AUDIO.FRAME_SAMPLES` at 16kHz) — a single 30-minute interview alone generates on the order of 100,000 billable messages. At any real usage this likely costs more than the ALB floor it would have replaced.

## Consequences

- **One instance, no auto-scaling, no self-healing.** A deliberate tradeoff for cost, not an oversight — accepted explicitly rather than revisited.
- **The NAT instance is a second thing that can go down and take outbound connectivity with it.** Its security group is tight by design — inbound TCP 443 from the private subnet's CIDR only, outbound TCP 443 to 0.0.0.0/0 only, nothing else — but it still needs its own patching story, which is not yet decided.
- **Instance management needs Systems Manager Session Manager**, not SSH or a bastion host — the private instance has no public IP and no inbound port opened for management; SSM's agent only makes outbound connections, the same shape as everything else this instance does.
- **Free DynamoDB and S3 gateway VPC endpoints are used regardless of the NAT instance.** Only interface endpoints (Bedrock, SQS, Cognito, CloudWatch Logs — ~$7-8/month each per AZ) are the cost this ADR avoids; gateway endpoints cost nothing and keep DynamoDB, almost certainly the backend's highest-volume call, off both the NAT instance and the public internet entirely.
- **CloudWatch Logs now needs its own path to AWS**, since there is no ECS `awslogs` driver doing it automatically — the CloudWatch agent (or equivalent) running on the instance, routed through the NAT instance like everything else, is the only way the existing EMF metrics and alarms keep working.
- Nothing in `infra/terraform` reflects this yet. Building it needs a VPC extension (public + private subnet, the NAT instance, route tables, the two gateway endpoints), a compute module for the backend instance, and CloudFront's VPC origin wired to it.
