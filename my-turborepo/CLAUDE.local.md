# PrepPilot AI — Phase Tracker
> Local only — gitignored. Updated as work progresses.
> Last updated: 2026-09-09

---

## Current position: end of Phase 4, plus the profile refactor

The candidate signs in, saves a profile once (name, resume, GitHub), then picks
a role and holds a full spoken interview with Nova 2 Sonic that persists its
transcript to DynamoDB. **Nothing reads that transcript back yet** — the
Evaluator, the Coach and the results page are all still to build.

**Phase 4.5 — candidate material is user-scoped (2026-09-09).** Resume and
GitHub moved off the session and onto `USER#<uid>/PROFILE`, captured once
instead of per interview. Personal identifiers are stripped with Comprehend
before the text is stored or reaches any model. Plans are cached per user and
invalidated lazily at plan time. Account erasure exists end to end. Full
reasoning in [ADR-0007](docs/adr/0007-user-scoped-redacted-candidate-material.md);
the Redis drop is finally recorded in
[ADR-0006](docs/adr/0006-drop-redis-dynamodb-alone.md).

| Phase | Status |
|-------|--------|
| 1 — Foundation + Planner | ✅ Complete |
| 2 — Resume + Auth + Database | ✅ Complete |
| 3 — WebSocket + Speech | ✅ Complete (Redis dropped — see below) |
| 4 — Sonic end-to-end | 🟡 ~85% — the loop runs; `Result.tsx` waits on Phase 5 |
| 4.5 — Profile, PII redaction, erasure | ✅ Complete |
| 5 — Evaluator + SQS | ⬜ Not started |
| 6 — Coach + RAG | ⬜ Not started |
| 7 — Deploy + CI/CD | 🔸 ~30% — CloudFront/S3/SSM/DynamoDB modules exist; no ECS, no CI |
| Testing (cross-cutting) | 🟡 Pass 1 done — 142 tests on pure logic and shared schemas. Routes and React are pass 2 |

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
- [x] `lib/s3.ts` — `S3Client` singleton, `putResume()` / `deleteResume()`.
      **Key changed in 4.5:** one object per user at `resumes/<uid>/resume.pdf`,
      overwritten on re-upload, not `resumes/<uid>/<sid>.pdf`
- [x] ~~`routes/preInterview.ts` — multipart~~ **superseded in 4.5.** Ingestion
      moved to `POST /api/v1/profile/resume`; this route now mints a session
      from the stored profile and takes no body
- [x] `lib/dynamo.ts` — `DynamoDBDocumentClient` singleton, `requireTable()`, `parseItem()` validate-on-read
- [x] `lib/sessions.ts` — the whole session lifecycle: `createSession` (one `TransactWriteCommand`), `loadPlannerInputs`, `attachPlan`, `startInterview`, `recordAnswer`, `finishInterview`
- [x] Frontend `FormData` upload + `ResumeField` component
- [ ] Replace axios GitHub call with `@octokit/rest` — installed since Phase 1,
      **still imported nowhere**. Now lives in `lib/github.ts`, shared by the
      profile and (until 4.5 removed its need) the pre-interview route

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
per ECS task. The original plan was Redis, which was dropped — see
[ADR-0006](docs/adr/0006-drop-redis-dynamodb-alone.md), which lists the three
remaining options. **Decide before scaling past one task.**

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

**Redis is out of the stack**, and as of 2026-09-09 that is finally written
down: [ADR-0006](docs/adr/0006-drop-redis-dynamodb-alone.md) supersedes ADR-0003,
which had sat marked *Accepted* for a month while describing infrastructure that
was never provisioned. `data-model.md` has been corrected too.

The remaining consequence is the rate-limiter carry-forward above.

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

## Phase 4.5 — Profile, PII redaction, erasure ✅

Candidate material moved from session-scoped to user-scoped. Reasoning in
[ADR-0007](docs/adr/0007-user-scoped-redacted-candidate-material.md).

### Data model
- [x] `USER#<uid>/PROFILE` — names, `resumeKey`, redacted `resumeText`, `repos`,
      `profileVersion`, `status`
- [x] `USER#<uid>/PLAN` — one cached plan per user, stamped with the
      `profileVersion` and `targetRole` it was built from
- [x] `type` on every item, `.default()`ed so rows written before it still parse
- [x] `EVAL#SUMMARY` → `SUMMARY` — it sat inside `begins_with("EVAL#")`, which
      is how completion is derived, so it would have fired the Coach early
- [x] `expiresAt` written by `sessionExpiresAt()`, one value shared by every item
      in a session. TTL had been enabled on the dev table for weeks with nothing
      writing the attribute, so it did nothing

### Backend
- [x] `lib/profile.ts` — profile and plan-cache access, `ADD profileVersion :one`
      so concurrent uploads cannot both read 3 and write 4
- [x] `lib/redact.ts` — Comprehend `DetectPiiEntities` + one phone pattern,
      **fails closed**. `DATE_TIME` deliberately kept: employment dates are what
      the Planner judges seniority from
- [x] `lib/erasure.ts` — mark → sweep → unmark, Cognito last. `AdminDeleteUser`
      verified against a real user 2026-09-09
- [x] `lib/github.ts`, `lib/cognitoAdmin.ts`
- [x] `routes/profile.ts` — `GET`/`PUT`/`DELETE /profile`, `POST /profile/resume`,
      `PUT /profile/github`
- [x] `routes/preInterview.ts` rewritten — no multipart, no scrape; mints a
      session from the profile. 219 lines → 97
- [x] `routes/plan.ts` — lazy cache check against the **session's**
      `profileVersion`, not the profile's current one

### Frontend
- [x] `pages/profile.tsx` — onboarding and edit in one screen
- [x] `pages/startInterview.tsx` — role selection, `/start`
- [x] `components/layout/RequireProfile.tsx` — keys on the server's `complete`
      boolean; a failed fetch is its own state, never a redirect
- [x] `lib/profile.tsx`, `lib/profileApi.ts`, `lib/httpErrors.ts`
- [x] `components/DeleteAccount.tsx` — type-to-confirm AlertDialog
- [x] `pages/form.tsx` **deleted**, with `PreInterviewBody` / `Resume` /
      `Response`

### Terraform (applied 2026-09-09)
- [x] `comprehend:DetectPiiEntities`, `s3:DeleteObject`, `dynamodb:DeleteItem`,
      `cognito-idp:AdminDeleteUser` scoped to the pool ARN
- [x] `audio/` prefix, its lifecycle rule and `audio_retention_days` removed

### Not done
- [ ] The onboarding guard and the upload state machine are still untested —
      exactly what the frontend skill asks for. Covered by testing pass 2; the
      runner itself now exists (see **Testing** below)
- [ ] `POST /profile/resume` re-scrapes GitHub on every resume upload, even
      when the URL has not changed — a wasted call against an unauthenticated
      60/hr quota shared by every user. (`PUT /profile/github` is fine: the
      client only calls it when the URL actually changed.)

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
- ~~Audio bucket prefix~~ — **decided against.** Audio is never persisted; it
      streams through the WebSocket and is discarded, and the transcript is the
      durable record. The `audio/` prefix, its lifecycle rule and the `audioKey`
      attribute were all removed. `durationMs` + transcript length is a usable
      pacing signal for the Evaluator without storing a byte of voice

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
- [ ] **`.github/workflows/` does not exist.** No deploy pipeline, no PR checks.
      Deliberately deferred — the runner and the `test` task it will call exist,
      so the workflow is now a thin wrapper rather than a design problem
- [x] `check-types` wired for all four workspaces
- [x] `test` wired as a turbo task — `bun run test` fans out from the root
- [x] `build.ts` — production `Bun.build()`, fails on missing `BUN_PUBLIC_*`
- [ ] Upload `dist/` to S3 on deploy
- [ ] Presigned URL flow for resume/audio

---

## Testing 🟡

Started 2026-09-09, ahead of Phase 5, so CI has something to run and the
Evaluator lands on a codebase that can be tested rather than one retrofitted
afterwards.

**Runner: `bun test`, NOT Jest.** Both apps are ESM TypeScript run by Bun, so
Jest would need `@swc/jest`, ESM flags and `moduleNameMapper`, and would run
tests under Node while production runs Bun. `bun:test` implements the Jest API
(`describe`/`it`/`expect`), so the tests read as Jest tests and stay portable if
that tradeoff ever changes.

Jest was checked properly rather than dismissed. It is *viable*: `apps/servers`
uses no Bun APIs at all, and `lib/multipart.ts` is pure web standard
(`Readable.toWeb`, `new Request`, `formData()` — all Node 18+). The Bun surface
is `apps/web/src/index.ts` (`serve`) and `build.ts` (`Bun.Glob`/`Bun.build`),
neither of which is unit-testable. So the decision was fidelity and config cost,
not capability.

Conventions:
- `__tests__/` mirroring source at each workspace root
- `packages/shared/tsconfig.json` carries `include: ["src", "__tests__"]` and
  `types: ["bun"]` so tests type-check; `apps/servers` includes them by default
- `test` is a turbo task — CI calls `bun run test` and `bun run check-types`

### Pass 1 ✅ — pure logic and shared schemas (142 tests)

- [x] `packages/shared/__tests__/schemas/` — `preInterview`, `plan`, `profile`,
      `session`
- [x] `apps/servers/__tests__/lib/` — `exchangeBuffer`, `errors`

The cases worth knowing are the ones encoding a real defect or near-miss:
- `extractGithubUsername` rejects `evil.com/<user>`, `github.com@evil.com`,
  `github.com.evil.com` and percent-encoded traversal — the boundary between
  user input and an outbound request path
- `SORT_KEY.EVAL_SUMMARY` sits outside the `begins_with("EVAL#")` range. The
  near-miss that would have fired the Coach a question early is now a failing
  test rather than a comment. **Phase 5 depends on this holding**
- `ExchangeBuffer` merges fragments into one exchange, replaying the real event
  order — the bug that turned one spoken answer into eight DynamoDB items
- `PlanRequestSchema` strips client-supplied `repos`/`resumeText` (ADR-0007)
- The all-zero `questionMix` that passes every field bound and still describes
  no interview
- The `.default()`ed `type` attribute, so pre-refactor rows still parse

No production code changed and no defects surfaced — every test asserts current
behaviour and passed first run.

### Pass 2 ⬜ — routes and React

- [ ] Route handlers with mocked AWS. **Chosen approach: `aws-sdk-client-mock`
      at the SDK layer.** Open risk: it is not officially tested against Bun —
      verify before building on it, fall back to `mock.module()` on the `lib/*`
      client singletons, which needs no production change
- [ ] `RequireProfile` onboarding guard and the resume upload state machine
      (needs `happy-dom` + Testing Library; read the frontend skill first)
- [ ] `useInterview` ten-state union

---

## Open decisions

**Ministral is back (2026-09-09). Resolved.** It stopped responding in
us-east-1 on 2026-09-03 — connection accepted, no bytes ever sent, surfacing
only as `TimeoutError: Stream timed out because of no activity` — and was
demoted to last so the chain could recover by itself. It has. Re-probed with
`bun scripts/modelProbe.ts`:

| Model | 2026-09-03 | 2026-09-09 |
|-------|-----------|-----------|
| `mistral.ministral-3-8b-instruct` | 30s timeout | **362ms** |
| `us.meta.llama4-scout-17b-instruct-v1:0` | 280ms | 354ms |
| `qwen.qwen3-coder-30b-a3b-v1:0` | 478ms | **8796ms** |

Ministral is primary again, which restores CLAUDE.md's locked decision and
matches the order `bedrock_text_model_ids` in the IAM module already documented
— `lib/config.ts` had drifted from both.

Two things worth carrying forward. **Qwen degraded 18x** and is now a last
resort rather than a peer; if the first two ever fail together, a candidate
waits nine seconds. And the outage defences stay regardless of ordering —
`MAX_ATTEMPTS: 1`, the 30s request timeout, and the warn-on-fallback log are
what made this cheap to diagnose and survive.

Cost note still applies: the Evaluator runs once per question, so a 15-question
round multiplies whichever model answers by fifteen. Ministral being primary is
the cheap outcome.

---

## Known issues / open items

| Issue | File | Priority |
|-------|------|----------|
| No CI/CD at all; `.github/workflows/` absent | — | High before deploy |
| Editing `packages/shared` does not invalidate the dev server's cached module | Bun dev server | Medium — restart after any shared edit |
| Rate limiter is in-memory; per-task budget | `apps/servers/lib/rateLimit.ts` | Medium — options in ADR-0006 |
| No tests under `apps/web` at all; the profile guard and upload state machine are untested | `apps/web/` | Medium — the frontend skill asks for it. Testing pass 2 |
| No route tests; every handler's auth guard and status mapping is unexercised | `apps/servers/routes/` | Medium — testing pass 2 |
| `AdminDeleteUser` retry path (`UserNotFoundException`) never exercised for real | `apps/servers/lib/cognitoAdmin.ts` | Low — covered by construction |
| GitHub scraping uses axios; `@octokit/rest` installed, unused | `apps/servers/lib/github.ts` | Medium |
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

**Resolved 2026-09-09 (profile refactor):** raw resume text no longer stored or
sent to any model · resume re-uploaded once per account instead of once per
interview · plans reused across interviews · account erasure end to end ·
`data-model.md` and ADR-0003 corrected · `USER#<uid>/SESSION#<sid>` refs now
deleted on erasure (they survived every one before) · `EVAL#SUMMARY` moved off
the `EVAL#` prefix before it could fire the Coach a question early · TTL
`expiresAt` actually written (the dev table had TTL enabled on an attribute
nothing populated, so retention was inert).

---

## Terraform structure note

`CLAUDE.md §7` shows flat per-service `.tf` files inside the environment
directory. **Reality diverged and the module pattern won**: every service is a
reusable module under `infra/terraform/modules/` (`iam`, `ssm`, `s3`,
`cloudfront`, `cognito`, `vpc`, `dynamodb`), composed by
`environments/dev/main.tf`. There is deliberately no `elasticache` module —
[ADR-0006](docs/adr/0006-drop-redis-dynamodb-alone.md).

Keep doing that — new resources go into a module, not loose into an environment
root. `infra/terraform/CLAUDE.md` documents the conventions; `CLAUDE.md §7` is
the stale one and should be corrected to match.