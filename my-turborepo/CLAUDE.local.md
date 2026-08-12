# PrepPilot AI — Phase Tracker
> Local only — gitignored. Updated as work progresses.
> Last updated: 2026-07-10

---

## Current position: Weeks 1–2 (wrapping up)

---

## Phase 1 — Weeks 1–2: Foundation + Planner Agent

### Backend
- [x] Turborepo monorepo scaffold (`apps/servers`, `apps/web`, `packages/shared`)
- [x] `packages/shared` — `PreInterviewBody`, `PlanRequestSchema`, `PlanResponseSchema` (mock-only)
- [x] `lib/bedrock.ts` — `BedrockRuntimeClient` singleton
- [x] `lib/config.ts` — typed config module (single `process.env` boundary)
- [x] `lib/messages.ts` — user-facing strings
- [x] `agents/planner.ts` — rule-based Planner agent (mock-only, v2 will swap for ConverseCommand)
- [x] `routes/preInterview.ts` — `POST /api/v1/pre-interview` (GitHub scrape via axios + Zod-validated response)
- [x] `routes/plan.ts` — `POST /api/v1/plan`
- [x] `index.ts` — clean entry point, no inline routes
- [ ] Replace axios GitHub call with `@octokit/rest` ← **still needed**

### Frontend
- [x] React 19 + BrowserRouter with `/form`, `/interview`, `/results` routes
- [x] `Form.tsx` — GitHub URL input, POST to backend
- [x] shadcn/ui components (Button, Input, Card, Label, Select, Textarea, Sonner)
- [ ] **Navigation bug**: `Form.tsx` never calls `SetPage` after submit ← **still needed**
- [ ] `Interview.tsx` — empty stub (built in Phase 3)
- [ ] `Result.tsx` — empty stub (built in Phase 4)

### Terraform
- [x] `environments/global/` — S3 state bucket + versioning, IAM user `prepilot-terraform` with `AdministratorAccess`, access key
- [x] `environments/global/` — migrated from local → S3 backend (`use_lockfile = true`)
- [x] `modules/iam/` — `prepilot-server-role-{env}` + Bedrock invoke policy (scoped to 3 model ARNs)
- [x] `environments/dev/` — IAM module applied, role + policy live in AWS
- [ ] `environments/prod/` — empty, not wired yet

### Codebase hygiene
- [x] `claude.md` — coding standards + full architecture doc
- [x] `.gitignore` — Terraform state, tfvars, `.claude.local.md`
- [x] Removed dead files: `scrappers/github.ts`, `APITester.tsx`, `hooks/useFetch.tsx`
- [x] Removed concept mastery code: `quiz_history` table, planner concept path, `z.enum(["concept","mock"])` → `["mock"]`

---

## Phase 2 — Weeks 3–4: Resume + Auth + Database

### Backend
- [ ] Install `@octokit/rest`, replace axios GitHub call in `routes/preInterview.ts`
- [ ] Install `multer` + `unpdf`
- [ ] Update `routes/preInterview.ts` — add resume PDF upload + parse (parallel with GitHub scrape via `Promise.all`)
- [ ] `lib/dynamo.ts` — `DynamoDBDocumentClient` singleton
- [ ] `lib/constants.ts` — DynamoDB table name, key prefixes, Bedrock model IDs (no magic strings)
- [ ] JWT validation middleware — validate Cognito JWT locally against JWKS, cache public keys

### Terraform
- [ ] `modules/cognito/` — user pool, app client, hosted UI
- [ ] Wire cognito into `environments/dev/main.tf`
- [ ] `environments/dev/dynamodb.tf` (flat file) — single table with GSI on SK
  - PK: `SESSION#<sid>`, SK: `META` / `ANSWER#<qId>` / `EVAL#<qId>` / `COACH`
  - GSI: SK → PK for user history lookup (`USER#<uid>` → `SESSION#<sid>`)
- [ ] Update `modules/iam/` — add DynamoDB + S3 read/write to server role (scoped to session prefixes)

### Frontend
- [ ] Fix `Form.tsx` navigation bug — call `SetPage("interview")` after successful POST
- [ ] Amplify setup — `lib/auth.ts` with Cognito user pool config
- [ ] Login / signup flow (Cognito hosted UI or custom form with Amplify)
- [ ] Resume file input in `Form.tsx` — `multipart/form-data` upload

---

## Phase 3 — Weeks 5–6: WebSocket + Transcribe

### Backend
- [ ] Switch Express from HTTP-only to WebSocket support (`ws` or `express-ws`)
- [ ] `routes/interview.ts` — WebSocket handler (replaces REST chat endpoint)
  - Open Transcribe streaming session per WS connection
  - Relay audio chunks: client → Transcribe → transcript event
  - Call Bedrock `ConverseCommand` on transcript → next question
  - Stream Polly audio back to client
  - Write Q&A pair to DynamoDB each turn
  - Update Redis (turn count, current question index)
- [ ] `lib/transcribe.ts` — `TranscribeStreamingClient` singleton
- [ ] `lib/redis.ts` — `ioredis` client singleton (ElastiCache in prod, local Redis in dev)
- [ ] `agents/mockInterview.ts` — turn loop orchestrator (Transcribe → Bedrock → Polly)

### Frontend
- [ ] `hooks/useRecorder.ts` — mic capture + `MediaRecorder`, streams audio chunks over WebSocket
- [ ] `hooks/useInterview.ts` — interview session state machine (connecting / active / ended)
- [ ] `components/Interview.tsx` — full interview UI: audio visualizer, transcript, question display

### Terraform
- [ ] `environments/dev/elasticache.tf` — Redis cluster, subnet group, security group
- [ ] `environments/dev/vpc.tf` — VPC, public + private subnets, NAT, SGs

---

## Phase 4 — Week 7: Bedrock + Polly End-to-End

### Backend
- [ ] `lib/polly.ts` — `PollyClient` singleton
- [ ] Wire `ConverseCommand` inside `agents/mockInterview.ts`
  - System prompt: candidate background (resume + GitHub summary from Planner)
  - User turn: transcript from Transcribe
  - Response: next question or follow-up
- [ ] Polly `SynthesizeSpeech` — neural engine, stream MP3/PCM back over WebSocket
- [ ] Persist running transcript to DynamoDB each turn (`ANSWER#<qId>` items)

### Frontend
- [ ] Receive Polly audio blob over WebSocket, play via `AudioContext`
- [ ] `components/Result.tsx` — scores + improvement plan display

---

## Phase 5 — Week 8: Evaluator + SQS

### Backend
- [ ] `agents/evaluator.ts` — scores answer on correctness / clarity / depth (0–10 each), `ConverseCommand`
- [ ] `lib/sqs.ts` — `SQSClient` singleton
- [ ] After interview ends: enqueue each Q&A pair to `eval-queue` via `SendMessageCommand`
- [ ] Fargate Spot worker (`apps/worker/`) — polls SQS, runs Evaluator agent, writes `EVAL#<qId>` to DynamoDB
  - Completion counter: `UpdateItem ADD completedCount 1`
  - When count hits total questions: trigger Coach agent

### Terraform
- [ ] `environments/dev/sqs.tf` — `eval-queue`, DLQ, redrive policy (`maxReceiveCount: 3`)
- [ ] `environments/dev/compute.tf` — ECS cluster, main Fargate service + Spot worker service
- [ ] Second IAM role for Evaluator worker — scoped to `bedrock:InvokeModel` + DynamoDB write on `EVAL#*` items only
- [ ] `environments/dev/s3.tf` — resume bucket (`resumes/<uid>/<sid>.pdf`), audio bucket (`audio/<sid>/<qId>.webm`)

---

## Phase 6 — Week 9: Coach + RAG

### Backend
- [ ] `agents/coach.ts` — reads all `EVAL#*` items for session, retrieves relevant material from Bedrock Knowledge Base, generates improvement plan
- [ ] `lib/bedrockKB.ts` — `BedrockAgentRuntimeClient` singleton (Knowledge Base retrieval)
- [ ] Write plan to DynamoDB under `SESSION#<sid> / COACH`
- [ ] REST endpoint `GET /api/v1/coach/:sessionId` — client polls for improvement plan

### Terraform
- [ ] `environments/dev/bedrock.tf` — Knowledge Base resource + S3 data source (study documents bucket)
- [ ] Update IAM — add `bedrock:Retrieve` permission on KB ARN to main role

---

## Phase 7 — Weeks 10–12: Deploy + CI/CD + Observability

### Terraform
- [ ] `environments/dev/cloudfront.tf` — CDN in front of frontend S3 bucket
- [ ] `environments/dev/ssm.tf` — SSM Parameter Store entries for all runtime config
- [ ] `environments/dev/cloudwatch.tf` — log groups for both ECS services, metric alarms (error rate, latency, DLQ depth)
- [ ] `environments/prod/` — mirror all dev modules with prod-grade values (PITR on, Multi-AZ Redis, deletion protection)

### CI/CD
- [ ] `.github/workflows/deploy.yml` — on push to `main`: build → push to ECR → deploy to ECS (rolling update)
- [ ] `.github/workflows/pr-checks.yml` — on PR: type-check, lint, test

### Frontend
- [ ] `build.ts` — production `Bun.build()` output to `dist/`, uploaded to S3 on deploy
- [ ] Presigned URL flow for resume/audio — browser uploads directly to S3 (no proxy through Express)

---

## Known issues / open items

| Issue | File | Priority |
|-------|------|----------|
| Navigation bug — `SetPage` never called after form submit | `apps/web/src/components/Form.tsx` | High — blocks all frontend testing |
| GitHub scraping uses axios instead of `@octokit/rest` | `apps/servers/routes/preInterview.ts` | Medium — functional but wrong library per claude.md |
| `frontend.tsx` uses non-null assertion `getElementById("root")!` | `apps/web/src/frontend.tsx` | Low — bundler entry point, acceptable |
| `environments/global/terraform.tfstate` exists locally with IAM secret key | Local disk only | Medium — gitignored, but migrate global to S3 backend ASAP |
| `environments/prod/` — empty placeholder files | `infra/terraform/environments/prod/` | Low — not needed until Phase 7 |

---

## Terraform structure note

`claude.md §7` shows a flat file structure (`vpc.tf`, `cognito.tf`, etc.) inside the environment directory rather than the module-per-service pattern currently in use. The current `modules/iam/` approach is more reusable but diverges from the doc. Plan: keep the module pattern for IAM (already deployed), use flat `.tf` files per service for everything added in Phases 2–7 inside `environments/dev/`.
