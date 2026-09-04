# PrepPilot AI — Phase Tracker
> Local only — gitignored. Updated as work progresses.
> Last updated: 2026-09-04

---

## Current position: end of Phase 4

The candidate can sign in, upload a resume, get a Planner-built session plan,
and hold a full spoken interview with Nova 2 Sonic that persists its transcript
to DynamoDB. **Nothing reads that transcript back yet** — the Evaluator, the
Coach and the results page are all still to build.

| Phase | Status |
|-------|--------|
| 1 — Foundation + Planner | ✅ Complete |
| 2 — Resume + Auth + Database | ✅ Complete |
| 3 — WebSocket + Speech | ✅ Complete (Redis dropped — see below) |
| 4 — Sonic end-to-end | 🟡 ~85% — the loop runs; `Result.tsx` waits on Phase 5 |
| 5 — Evaluator + SQS | ⬜ Not started |
| 6 — Coach + RAG | ⬜ Not started |
| 7 — Deploy + CI/CD | 🔸 ~30% — CloudFront/S3/SSM/DynamoDB modules exist; no ECS, no CI |

**Next highest-leverage step:** `agents/evaluator.ts`. Everything downstream —
the Coach, the results page, the whole post-interview half of the product —
sits behind it, and the transcript it consumes is already being written.

---

## Phase 1 — Foundation + Planner Agent ✅

### Backend
- [x] Turborepo monorepo scaffold (`apps/servers`, `apps/web`, `packages/shared`)
- [x] `packages/shared` — auth, `preInterview`, `plan` and `session` schemas
- [x] `lib/bedrock.ts` — `BedrockRuntimeClient` singleton + `converseText()` fallback helper
- [x] `lib/config.ts` — typed config module (single `process.env` boundary)
- [x] `lib/messages.ts` / `lib/constants.ts`
- [x] `agents/planner.ts` — real `ConverseCommand` call, few-shot exemplar, JSON extraction
- [x] `routes/preInterview.ts`, `routes/plan.ts`, clean `index.ts`

### Frontend
- [x] React 19 + BrowserRouter, `/form` `/interview` `/results`
- [x] shadcn/ui component set
- [x] `form.tsx` — full submit → plan → interview flow

### Terraform
- [x] `environments/global/` — S3 state bucket, versioning, `prepilot-terraform` IAM user, S3 backend
- [x] `modules/iam/` — server role + Bedrock invoke policy
- [x] `environments/dev/` — applied

---

## Phase 2 — Resume + Auth + Database ✅

### Backend
- [x] JWT validation middleware — `lib/cognitoAuth.ts`, `aws-jwt-verify` against Cognito JWKS
- [x] Resume upload + parse — `unpdf`; **`multer` deliberately not used**, `lib/multipart.ts` bridges Express's `IncomingMessage` to a web `Request` so Bun's own `formData()` parses it
- [x] `lib/s3.ts` — `S3Client` singleton + `putResume()`, raw PDF at `resumes/<uid>/<sid>.pdf`
- [x] `routes/preInterview.ts` — multipart only; GitHub scrape and PDF parse overlap via `Promise.all`
- [x] `lib/dynamo.ts` — `DynamoDBDocumentClient` singleton, `requireTable()`, `parseItem()` validate-on-read
- [x] `lib/sessions.ts` — the whole session lifecycle: `createSession` (one `TransactWriteCommand`), `loadPlannerInputs`, `attachPlan`, `startInterview`, `recordAnswer`, `finishInterview`
- [x] Frontend `FormData` upload + `ResumeField` component
- [ ] Replace axios GitHub call with `@octokit/rest` — installed since Phase 1, **still imported nowhere**

### Terraform
- [x] `modules/cognito/` — user pool, app client, Google IdP, `auth.tharunsekar.xyz`
- [x] `modules/dynamodb/` — `prepilot-sessions-<env>`, PAY_PER_REQUEST, PITR and deletion-protection flags, optional TTL. Wired into `environments/dev/main.tf`
- [x] `modules/iam/` extended — DynamoDB (`GetItem`/`PutItem`/`UpdateItem`/`Query`/`BatchGetItem`/`BatchWriteItem`), S3 read/write, and `bedrock:InvokeModelWithBidirectionalStream`

**Design divergence, resolved deliberately:** the planned **GSI on SK no longer
exists and is not needed**. User history is a first-class main-table partition
— `PK: USER#<uid>` / `SK: SESSION#<sid>`, written in the same transaction as
the session's `META` item — so a history lookup is a plain `Query` on the base
table. A GSI would have been a second copy of the same access pattern with
eventual consistency attached.

### Frontend
- [x] Amplify + Cognito + Google OAuth, `signup` / `signin` / `confirm` / `callback`
- [x] `lib/auth.tsx` `AuthProvider`, `RequireAuth` / `RedirectIfAuthenticated` guards
- [x] `lib/api.ts` — authenticated axios client, access token per request

---

## Phase 2.5 — Security hardening ✅

- [x] JWT attached on every API call; `fetchAuthSession` refresh per request
- [x] `helmet()`, 16kb JSON cap, `trust proxy 1`
- [x] Per-user rate limiting keyed on the Cognito `sub`
- [x] GitHub URL validated by real `URL` parsing + username allowlist
- [x] 5s timeout on the upstream GitHub call
- [x] Cognito errors mapped to safe copy — closes the sign-in enumeration oracle
- [x] Plaintext password removed from router history state
- [x] Multi-origin CORS, fails loudly on an empty allowlist
- [x] Build and runtime fail loudly on missing `BUN_PUBLIC_*`
- [x] All user-facing copy in `lib/messages.ts`

**Carry-forward:** the rate limiter store is still in-memory, so the budget is
per ECS task. The original plan was to move it to Redis — but Redis was dropped
(below), so this now needs either a DynamoDB-backed store or an accepted
per-task budget. **Decide before scaling past one task.**

---

## Phase 3 — WebSocket + Nova Sonic ✅

### Backend
- [x] `ws` wired to the HTTP server's `upgrade` event — the only place a
      handshake can be authenticated before a socket exists
- [x] `routes/interview.ts` (~530 lines) — connection handler, event union,
      tool dispatch, clock, transcript persistence
- [x] `lib/sonic.ts` (~735 lines) — `SonicSession` (one bidirectional stream)
      and `SonicConversation` (renewal across streams), `NodeHttp2Handler`
- [x] `agents/mockInterview.ts` — `buildInterviewSystemPrompt()` plus the three
      tool specs (`logExchange`, `getSessionState`, `endInterview`) with Zod
      input schemas
- [x] `lib/exchangeBuffer.ts` — merges partial `textOutput` events into
      completed exchanges
- [x] Streams closed on disconnect, heartbeat ping/pong, idle timeout

### Frontend
- [x] `lib/audio/capture.ts` — AudioWorklet, 16 kHz 16-bit PCM mono
- [x] `lib/audio/playback.ts` — scheduled 24 kHz LPCM playback
- [x] `hooks/useInterview.ts` — the ten-state union, barge-in, level metering
- [x] `pages/interview.tsx` — orb, clock, captions, always-reachable stop
- [x] `lib/interviewSocket.ts`

### Terraform
- [x] `modules/vpc/` — VPC, public + private subnets, NAT, route tables, SGs
- [x] ~~ElastiCache Redis~~ — **dropped, see below**

**Redis is out of the stack.** No `ioredis`, no `lib/redis.ts`, no ElastiCache
module. Turn count and question index live in the Sonic session's own state and
in DynamoDB, which is where the transcript had to go anyway — a second store
holding a copy of it earned nothing and added an always-on cluster to the bill.
Consequences: the rate-limiter carry-forward above has no Redis destination,
and `docs/architecture/data-model.md` still documents Redis keys that no longer
exist. **The data-model doc is the stale one.**

---

## Phase 4 — Sonic end-to-end 🟡

### Backend
- [x] System prompt built from the candidate's plan, resume and repos
- [x] Transcript persisted per exchange via `recordAnswer` (`ANSWER#<qId>`),
      `finishInterview` on close
- [x] **Stream renewal past Bedrock's ~8-minute bidirectional cap** — a fresh
      stream is opened before the ceiling with the last `MAX_REPLAYED_EXCHANGES`
      replayed as context. Measured ceiling: ~7m19s
- [x] **Hard timer** — `targetMinutes` plus `HARD_STOP_GRACE_MS`, enforced in
      code. The prompt's own budget was overrun by eight minutes in a measured
      48-minute session, so the clock is not left to the model
- [x] Two-stage wrap-up nudges (T-3min, T-1min)

### Frontend
- [x] Buffered Web Audio playback (no `<audio>` blob)
- [ ] `Result.tsx` — deliberate 36-line placeholder that says feedback is not
      wired yet, rather than a skeleton promising data that is not coming.
      Unblocks with Phase 5/6

---

## Phase 5 — Evaluator + SQS ⬜

Nothing started. The transcript it consumes is already being written, so this
is unblocked today.

### Backend
- [ ] `agents/evaluator.ts` — correctness / clarity / depth (0–10), `ConverseCommand`
- [ ] `lib/sqs.ts` — `SQSClient` singleton
- [ ] On interview end: enqueue each Q&A pair to `eval-queue`
- [ ] `apps/worker/` — Fargate Spot worker, polls SQS, writes `EVAL#<qId>`
  - Completion counter: `UpdateItem ADD completedCount 1`
  - Coach fires when the count reaches `questionCount` (already written by `attachPlan`)
  - Idempotent by `questionId` via `PutItem` — SQS is at-least-once

### Terraform
- [ ] `sqs` module — `eval-queue`, DLQ, `maxReceiveCount: 3`
- [ ] `ecs` module — cluster, API service, Spot worker service
- [ ] **Second IAM role for the worker** — `bedrock:InvokeModel` + DynamoDB
      write on `EVAL#*` only. Never shared with the API role
- [ ] Audio bucket prefix (`audio/<sid>/<qId>`) if audio retention is wanted —
      `recordAnswer` currently writes `audioKey: null`

---

## Phase 6 — Coach + RAG ⬜

- [ ] `agents/coach.ts` — reads all `EVAL#*`, retrieves from the KB, writes `COACH`
- [ ] `lib/bedrockKB.ts` — `BedrockAgentRuntimeClient` singleton
- [ ] `GET /api/v1/coach/:sessionId`
- [ ] `bedrock` module — Knowledge Base + S3 data source
- [ ] IAM — `bedrock:Retrieve` on the KB ARN

---

## Phase 7 — Deploy + CI/CD + Observability 🔸

### Terraform
- [x] `modules/cloudfront/`, `modules/s3/`, `modules/ssm/`, `modules/dynamodb/`
- [ ] Extend `ssm` to cover **all** runtime config, not just Google creds
- [ ] `cloudwatch` module — log groups, alarms (error rate, latency, DLQ depth)
- [ ] `environments/prod/` — still five empty files

### CI/CD
- [ ] **`.github/workflows/` does not exist.** No deploy pipeline, no PR checks
- [x] `check-types` wired for all four workspaces
- [x] `build.ts` — production `Bun.build()`, fails on missing `BUN_PUBLIC_*`
- [ ] Upload `dist/` to S3 on deploy
- [ ] Presigned URL flow for resume/audio

---

## Open decisions

**Ministral is dead in us-east-1 (2026-09-03).** It accepts the connection and
never sends a byte — surfacing only as `TimeoutError: Stream timed out because
of no activity`. With no client timeout that hung `/plan` indefinitely; with
one it cost 3 × 30s of retries before the chain fell through to Llama. Fixed by
demoting it to last in `DEFAULT_TEXT_MODELS`, `maxAttempts: 1`, a 30s request
timeout, and a warn log whenever a fallback answers.

**This contradicts CLAUDE.md's locked decision ("Ministral 3 8B for text").**
Either that line changes or `lib/config.ts` reverts — decide once you know
whether Ministral is coming back. Verify with `bun scripts/modelProbe.ts`,
which times each model in the chain individually. Note the cost consequence:
Llama 4 Scout 17B and Qwen 3 Coder 30B both bill above Ministral 3 8B, and the
Evaluator runs once per question.

---

## Known issues / open items

| Issue | File | Priority |
|-------|------|----------|
| Ministral primary contradicts CLAUDE.md's locked decision | `lib/config.ts` | High — decide |
| No CI/CD at all; `.github/workflows/` absent | — | High before deploy |
| Editing `packages/shared` does not invalidate the dev server's cached module | Bun dev server | Medium — restart after any shared edit |
| Rate limiter is in-memory and now has no Redis destination | `apps/servers/lib/rateLimit.ts` | Medium — needs a new plan |
| `data-model.md` still documents Redis keys that no longer exist | `docs/architecture/data-model.md` | Medium — doc is stale |
| GitHub scraping uses axios; `@octokit/rest` installed, unused | `apps/servers/routes/preInterview.ts` | Medium |
| `turbo.json` `build.outputs` is `.next/**` | `turbo.json` | Low |
| `packages/ui/` unused; app uses its own `components/ui/` | `packages/ui/` | Low — delete |
| `/api/hello` demo routes still present | `apps/web/src/index.ts` | Low — delete |
| `environments/prod/` — five empty files | `infra/terraform/environments/prod/` | Low — Phase 7 |

**Resolved since 2026-08-19:** Form.tsx navigation · `apps/servers` `start`
script · `check-types` coverage · DynamoDB module and session persistence ·
Planner schema reshaped for adaptive interviews · unreachable Llama fallback
(bare model id → `us.` inference profile) · resume upload end-to-end · the
whole Sonic voice loop · 8-minute stream cap via renewal · interview hard timer
· frontend rebuild · Bedrock hang and silent-fallback (2026-09-04).

---

## Terraform structure note

`CLAUDE.md §7` shows flat per-service `.tf` files inside the environment
directory. **Reality diverged and the module pattern won**: every service is a
reusable module under `infra/terraform/modules/` (`iam`, `ssm`, `s3`,
`cloudfront`, `cognito`, `vpc`, `dynamodb`), composed by
`environments/dev/main.tf`.

Keep doing that — new resources go into a module, not loose into an environment
root. `infra/terraform/CLAUDE.md` documents the conventions; `CLAUDE.md §7` is
the stale one and should be corrected to match.