# PrepPilot AI — Phase Tracker
> **Tracked and pushed, despite the `.local` name.** It is committed to `dev`
> and public on GitHub — deliberately, as a record of how the build progressed.
> The `.claude.local.md` entry in `.gitignore` is a different file and does not
> match this one. Write nothing here you would not publish.
> Updated as work progresses. Last updated: 2026-09-18

---

## Current position: the product is built. Only deployment is left.

Every phase that a candidate can see is done. They sign in, save a profile
once, optionally paste a job description and name the company, hold a full
spoken interview with Nova 2 Sonic, read per-answer feedback as it lands, see
every past round on a history page, and get a two-track study roadmap built
from all of them.

**Seven agents, not four.** The original plan named Planner, Mock Interview,
Evaluator and Coach. Three more arrived with the job-description work and are
now load-bearing:

| Agent | Runs | Produces |
|-------|------|----------|
| Planner | once per session | focus areas, question mix, difficulty, length |
| Gap | once per session, if a posting was pasted | each requirement bucketed strong/weak/none |
| Company Intel | once per session, if a company was named too | interview style, focus, seniority bar |
| Mock Interview | the live Sonic stream | the interview itself |
| Evaluator | once per ANSWER | correctness/clarity/depth + a rewrite of weak answers |
| Session Summarizer | once per completed session | what the whole round showed, per category |
| Coach | on GET /coach | trends per topic, two-track roadmap |

**The one thing that has never been deployed is the application.** There is no
ECS, so nothing runs outside a laptop. That is the whole of what remains.

| Phase | Status |
|-------|--------|
| 1 — Foundation + Planner | ✅ Complete |
| 2 — Resume + Auth + Database | ✅ Complete |
| 3 — WebSocket + Speech | ✅ Complete (Redis dropped — see below) |
| 4 — Sonic end-to-end | ✅ Complete |
| 4.5 — Profile, PII redaction, erasure | ✅ Complete |
| 5 — Evaluator + SQS | ✅ Complete — the `ecs` module moved to Phase 7, where it belongs |
| 5.5 — Gap + Company Intel agents | ✅ Complete — not in the original plan |
| 6 — Coach | ✅ Complete **without RAG**, deliberately — see the phase below |
| 7 — Deploy + CI/CD + Observability | 🔸 ~40% — CI gates every PR; no ECS, no CD, no alarms, prod empty |
| Testing (cross-cutting) | 🟢 974 tests: 726 backend, 151 web, 97 shared. Backend 89.1% funcs / 90.2% lines |

**Next highest-leverage step: the `ecs` module.** It is the only thing between
this and a URL somebody else can open, and it blocks every other Phase 7 item.
It is also where the bill starts — see the cost note in Phase 7.

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
| 4 — Sonic end-to-end | ✅ Complete — `result.tsx` is real and reachable |
| 4.5 — Profile, PII redaction, erasure | ✅ Complete |
| 5 — Evaluator + SQS | 🟢 ~90% — agent, queue, worker, completion detection all live in dev. Only the `ecs` module is missing |
| 6 — Coach + RAG | ⬜ Not started — the last piece of product value |
| 7 — Deploy + CI/CD | 🔸 ~45% — CI runs on every PR; CloudFront/S3/SSM/DynamoDB/SQS/IAM modules exist; no ECS |
| Testing (cross-cutting) | 🟢 468 tests; backend 81.7% funcs / 87.9% lines. `lib/sonic.ts` + `routes/interview.ts` still deferred |

**Next highest-leverage step:** Phase 6, the Coach. It is the last piece of
product value left — everything before it now works and is visible. Hang its
trigger on the existing `attribute_not_exists(averages)` election in
`finalizeIfComplete` rather than inventing a second signal; that write is
already once-only, which is the whole reason `completedCount` was rejected.

The `ecs` module is the only thing left in Phase 5, and it is deploy work
rather than product work — it belongs with Phase 7.

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

## Phase 4 — Sonic end-to-end ✅

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
- [x] `result.tsx` — real, and reachable from the interview's end screen. Polls
      `GET /sessions/:id/evaluation` and shows per-answer scores as they land,
      with the candidate's own words beside each one

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
- [x] ~~The onboarding guard is untested~~ — `RequireProfile.test.tsx`, pass 2.
      The **upload state machine** in `ResumeField` is still untested
- [ ] `POST /profile/resume` re-scrapes GitHub on every resume upload, even
      when the URL has not changed — a wasted call against an unauthenticated
      60/hr quota shared by every user. (`PUT /profile/github` is fine: the
      client only calls it when the URL actually changed.)

---

## Phase 5 — Evaluator + SQS ✅

Backend, queue and worker are built, tested and applied to dev. The `ecs`
module was the last item and has moved to Phase 7, where it always belonged.

**The Evaluator now also writes a sample answer** for weak answers only — a
rewrite of the candidate's OWN answer, never a model answer about work they did
not do. The gate is per category: technical and role-specific on correctness
and depth, behavioural on correctness and clarity, because "depth" on a story
about disagreeing with a colleague mostly measures how long they talked.

It cannot gate before the call — the gate reads the scores the call produces —
so the prompt states the rule to keep strong answers cheap and the agent
enforces it afterwards. One round trip, on the one agent that runs once per
question.

### Backend ✅
- [x] `agents/evaluator.ts` — correctness / clarity / depth (0–10), via `converseText`
- [x] `lib/sqs.ts` — `SQSClient` singleton, `enqueueEvaluations` batched at 10
- [x] On interview end: enqueue each recorded answer to the eval queue
- [x] `lib/evaluations.ts` — owns every `EVAL#` command
- [x] `worker.ts` — polls SQS, scores, writes `EVAL#<qId>`
- [x] Idempotent by `questionId` via `PutItem`, plus a pre-flight duplicate
      check so a redelivery costs one read instead of a generation
- [x] **Completion detection.** `startEvaluationSummary` opens the rollup at
      enqueue; `finalizeIfComplete` runs after every score, and the last one
      writes `averages` and moves the session to `complete`

**`data-model.md` had the completion denominator wrong and has been corrected.**
It said `questionCount` — "total planned questions" — was the denominator. That
is wrong for any interview that did not run to plan, which is most of them,
because the hard timer exists precisely to stop one overrunning. A session
planned for ten questions that ended after six would wait for four evaluations
that were never queued and sit at `evaluating` **forever**, with nothing left in
the queue to ever look again. `SUMMARY.questionCount` now carries the number of
answers actually enqueued, which the API knows exactly.

The election is `attribute_not_exists(averages)` on the rollup. Two workers
finishing their final message milliseconds apart both count the same total and
both try to finalise; exactly one wins. **Phase 6 should hang the Coach trigger
on that same conditional write** — it is already the once-only signal.

**The phase tracker was wrong about completion and has been corrected.** This
section used to say `UpdateItem ADD completedCount 1`. There is no
`completedCount`: `ADD` is not idempotent, SQS is at-least-once, and a
redelivered message over-counts and fires the Coach early. Completion is
derived from `Query ... begins_with("EVAL#")`, which is exact by construction.
`session.ts` and `data-model.md` §1 both already said so — only this file
disagreed.

**Divergence from the plan, deliberate:** the worker is a second entrypoint in
`apps/servers` (`worker.ts`), not an `apps/worker/` workspace. It needs
`lib/dynamo`, `lib/bedrock`, `lib/config`, `lib/errors` and `lib/messages`, and
a separate workspace means duplicating all five or extracting another package.
The isolation that matters is the IAM task role, which attaches per ECS task
definition rather than per repository — same image, different command,
different role.

**Fail fast, by configuration not code.** The worker's task definition sets
`BEDROCK_TEXT_MODEL_IDS` to a single id. SQS redrive already provides retries,
so walking a three-model chain is a slower second retry mechanism whose latency
can outlive the visibility timeout — and a message redelivered mid-flight pays
for a second generation. `VISIBILITY_TIMEOUT_SECONDS` (120) must stay in sync
with the `sqs` module's `visibility_timeout_seconds`; nothing enforces it.

### Terraform — applied to dev 2026-09-10
- [x] `sqs` module — `prepilot-eval-<env>`, DLQ, `maxReceiveCount: 3`,
      SSE, 14-day DLQ retention, redrive-allow-policy naming the one source
- [x] **Second IAM role for the worker** — `prepilot-evaluator-worker-role-<env>`
- [x] `sqs:SendMessage` added to the API role, scoped to the queue ARN
- [x] Wired into `environments/dev`; `terraform validate` passes
- [x] **Applied to dev.** The queue exists. `EVAL_QUEUE_URL` must be set in
      `apps/servers/.env` from `terraform output eval_queue_url`, or the
      enqueue raises `ServiceError` at every interview end. (The test preload
      overrides it deliberately, so the suite is unaffected either way.)
- [x] ~~`ecs` module~~ — **moved to Phase 7.** It is deploy work, not product
      work, and listing it here made Phase 5 look unfinished when the queue,
      the worker and completion detection had all been live in dev for a week.

**`overview.md` §8 overstates what IAM can do, and the module says so.** It
describes the worker's grant as "DynamoDB write on `EVAL#*` items only". That
is not expressible: the only item-level condition key is
`dynamodb:LeadingKeys`, which constrains the **partition** key, and `EVAL#` is
a sort-key prefix. What is enforceable is the action list, and the worker's is
genuinely narrower than the API's — no `DeleteItem`, no `UpdateItem`, no
`BatchWriteItem`. It can add an evaluation and read what it needs to produce
one; it cannot remove a transcript, mutate a session's status, or run an
erasure sweep.

The worker role has **no `bedrock:InvokeModelWithBidirectionalStream`**, no S3,
no Cognito and no Comprehend. The missing bidirectional grant is the concrete
payoff of splitting the roles: a compromised or looping worker cannot open a
billable Sonic stream.

Cost: SQS is effectively free — per-request billing against a 1M/month free
tier, ~17 requests per interview, no per-hour charge. The `ecs` module is where
real money starts.
- ~~Audio bucket prefix~~ — **decided against.** Audio is never persisted; it
      streams through the WebSocket and is discarded, and the transcript is the
      durable record. The `audio/` prefix, its lifecycle rule and the `audioKey`
      attribute were all removed. `durationMs` + transcript length is a usable
      pacing signal for the Evaluator without storing a byte of voice

---

## Phase 5.5 — Gap and Company Intel agents ✅

Not in the original plan. Added when the job-description field arrived, and
both are **optional throughout**: no posting means neither runs and the
interview falls back to resume and GitHub alone, which is what this product
did before they existed.

- [x] `agents/gap.ts` — buckets each requirement strong/weak/none against the
      candidate's material, via Bedrock **Tool Use** rather than prompt-for-JSON
- [x] `agents/companyIntel.ts` — two Tavily searches, then an enum
      classification of style / focus / seniority
- [x] `routes/gap.ts`, `routes/companyIntel.ts`, both Cognito-protected
- [x] `lib/tavily.ts` — the **only non-AWS call in the service**. Search is
      retrieval, not inference, so Bedrock remains the only inference path. What
      leaves the VPC is a company name and two fixed phrases — never the resume,
      the transcript or a user id, and the module takes a company name and
      nothing else so it *cannot* leak candidate material
- [x] `lib/ssm.ts` — the Tavily key, read from Parameter Store at point of use

**The Gap agent needed a deterministic repair pass, and that is the lesson.**
Ministral returned eight of twelve requirements as `strong` including ones whose
own evidence said "not explicitly mentioned", and emitted the same requirement
twice with opposite buckets. The prompt already forbade both. `repairRequirements`
now demotes any non-`none` bucket whose evidence names an absence and collapses
restatements, keeping the weaker bucket — a false `none` costs a question the
candidate answers well, a false `strong` costs the gap the interview existed to
find. **Do not replace it with more prompt instructions.**

Company Intel **never throws**. Search down, search empty, key missing, model
refusing — every path returns the all-unknown reading, and an all-unknown
reading renders nothing in the prompt.

---

## Phase 6 — Coach ✅ (RAG deliberately deferred to v2)

**No Knowledge Base, no retrieval, no citations.** That is a decision, not an
unfinished item: everything the Coach says comes from rows this product already
wrote about this candidate's own interviews, and a KB would add infrastructure
before there was any evidence it was needed. `SessionCoachSchema` in session.ts
still carries `plan` and `citations` from the RAG sketch — **nothing writes it**.

- [x] `agents/sessionSummarizer.ts` — runs once per completed session, says what
      the whole round showed per category
- [x] `agents/coach.ts` — trends per topic, two-track roadmap
- [x] `routes/coach.ts` — `GET /api/v1/coach`, no session id (it reads all of them)
- [x] `pages/coach.tsx` + `TrendSparkline` — sparkline per topic, priority-ordered roadmap

**Every number is computed; the model only writes prose.** Directions, score
histories, track averages and priorities are arithmetic. The model contributes
one line per trend and up to four focus points per track, and any topic it
returns that the analysis did not produce is dropped on merge. "Do not invent
scores" is a property of the shape rather than an instruction.

**The access pattern is the design.** "Every evaluation for this user" is not
expressible — `EVAL#` items live under `SESSION#<sid>` with no attribute naming
a user, so it would be their session list plus one Query per session. The
Coach instead reads `USER#<uid>/SUMMARY#<completedAt>` in **one Query**. Those
rows now carry the three dimension averages and the session summary, which is
what lets the roadmap name subject matter rather than only delivery advice.

**Two tracks, and the confidence is in the data.** `communication` is
`confident` because clarity is scored on every answer. `technical` is **always
`tentative`**, even at 9/10: correctness and depth are read off whichever
questions the interviewer happened to ask, which is a sample of what someone
knows and not an examination of it. Presenting it with a clarity score's
authority would be overclaiming, and a candidate who works that out later stops
trusting the confident half too.

### Cached at `USER#<uid>/COACH`

A DynamoDB item, not Redis (ADR-0006) and not a `Cache-Control` header. The
freshness rule is not a duration — a report is valid until the candidate's
history changes and indefinitely if it does not — so no `max-age` expresses it,
and a browser cache cannot skip the Bedrock call that is the entire point.

**Only the prose is stored.** Every score, direction and priority is recomputed
per request from rows the handler had to read anyway, so a repaired or
backfilled row shows up immediately instead of after the next interview.

Invalidation is **pull-based**: a four-field stamp compared on read, not a
delete issued by whatever changed the data. Push invalidation has a failure this
codebase has already been bitten by — if the write succeeds and the delete does
not, the cache is stale forever with nothing that will ever look again.

| Stamp field | Catches |
|-------------|---------|
| `rowCount` | a session finished, or an old one aged out via TTL |
| `latestCompletedAt` | one row expiring while another lands — count unchanged |
| `summarisedCount` | the summarizer attaching a narrative to a row the report was already built without. Neither field above moves |
| `version` | a deploy changed the prompt. The one trigger with no signal in the data |

`runCoachAgent` takes optional `cachedProse` and returns
`{ report, prose, generated }`. It does not know what a cache is — the route
owns the freshness decision, because the route read the rows the stamp is
computed from. A failed generation returns `prose: null` and is deliberately not
cached: storing an empty generation would look fresh forever, turning one
transient Bedrock failure into a permanently numbers-only report.

`deleteProfileItems` names this SK explicitly. The USER partition has no prefix
sweep, so a cache added without a line there outlives the account it belongs to
— `__tests__/lib/erasure.test.ts` now asserts that, which nothing did before.
- [ ] No link from the results page to `/coach`

---

## Phase 7 — Deploy + CI/CD + Observability 🔸

### Terraform
- [x] `modules/` — `cloudfront`, `cognito`, `dynamodb`, `iam`, `s3`, `sqs`,
      `ssm`, `vpc`. All applied to dev
- [x] `ssm` carries the Tavily key; the server role has `ssm:GetParameter`
      scoped to that one parameter ARN plus `kms:Decrypt` narrowed by ViaService
- [ ] **`ecs` module — cluster, API service, Spot worker service.** The blocker:
      nothing else in this phase can land without it, and nothing runs outside a
      laptop until it does
- [ ] `cloudwatch` module — log groups, alarms (error rate, latency, DLQ depth,
      and Bedrock invocations — see the cost note below)
- [ ] Extend `ssm` to cover **all** runtime config, not just secrets
- [ ] `environments/prod/` — still five empty files (0 bytes each)

### CI/CD
- [x] **`.github/workflows/ci.yml` exists** and runs `check-types` and `test` on
      every PR and every push to `dev` and `master`. It caught the `mock.module`
      leak that three local passes missed — see the rule below
- [x] `check-types` wired for all four workspaces
- [x] `test` wired as a turbo task — `bun run test` fans out from the root
- [x] `build.ts` — production `Bun.build()`, fails on missing `BUN_PUBLIC_*`
- [ ] **No CD at all.** Nothing deploys; CI only gates
- [ ] Upload `dist/` to S3 on deploy
- [ ] Presigned URL flow for resume/audio

### Cost — read before starting this phase

This is where the bill begins, and two of the three charges run whether or not
anybody uses the app:

- **NAT Gateway** — ~$32/month per AZ plus data processing. With no ECS tasks it
  is currently pure waste. Decide one NAT or one per AZ *deliberately*; a second
  is the classic way this doubles silently
- **ALB** — same shape, smaller number
- **ECS Fargate** — per vCPU-hour. Scaling dev to zero between sessions is the
  same discipline as destroying the NAT

The `cloudwatch` alarm on Bedrock invocations matters more than it looks: Nova 2
Sonic bills by open stream duration, so a leaked stream is invisible until the
bill arrives. No `.tf` can cap it — an alarm is the closest infrastructure gets
to a safety net.

**Blocking dependency:** the rate limiter is in-memory, so its budget is per
task. That has to be decided BEFORE ECS runs more than one task, not after.
Options are in [ADR-0006](docs/adr/0006-drop-redis-dynamodb-alone.md).

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

### Pass 2 ✅ — routes and React (228 tests total)

**`aws-sdk-client-mock` works under `bun test`.** The risk flagged in pass 1 is
closed, but three things were needed to get there and none are obvious:

1. **Pass the CLASS, not the singleton instance** — `mockClient(DynamoDBDocumentClient)`.
   It stubs the prototype, so the already-constructed `dynamoClient` in
   `lib/dynamo.ts` is intercepted. Passing the instance also works but does not
   generalise to modules that build their own client.
2. **`overrides: { "@smithy/types": "4.17.2" }` in the root package.json.**
   Without it a single `mockClient()` call produced **11 type errors**:
   `aws-sdk-client-mock` declares no `@smithy/types` of its own and resolved
   4.16.0 while `lib-dynamodb` uses 4.17.2, so the structural `Client` types
   did not match. Runtime was fine throughout — this was type-only, and it
   would have failed CI while passing locally under `bun test`.
3. **`.on()` ordering matters** — register the catch-all FIRST and the specific
   input matcher after it. Reversed, the catch-all swallows everything.

Test-only infrastructure, no production code changed:
- `bunfig.toml` in both apps with a `preload`. `lib/config.ts` (both sides)
  reads env at module scope and throws, so a router or component cannot even be
  imported without it. Deliberately preferred to making config lazy —
  failing loudly on missing config is what production wants.
- `apps/web` uses **happy-dom** + React Testing Library. `AudioWorklet`,
  `AudioContext` and `WebSocket` are stubbed at the module boundary per the
  frontend skill; injected events drive the hook.
- `__tests__/helpers/testApp.ts` mounts a router on a throwaway Express app on
  port 0. It does NOT import `index.ts`, which calls `app.listen()` and
  `attachInterviewSocket()` at module scope.

- [x] `routes/profile.test.ts` (22) — the `handleFailure` status mapping, and
      that `ServiceError`/`GithubError` detail never reaches the client
- [x] `useInterview.test.ts` (31) — the ten-state union
- [x] `RequireProfile.test.tsx` (9) — the onboarding guard
- [x] `httpErrors.test.ts` (24) — field vs global failure scoping

Cases worth knowing:
- `GET /profile` never serialises `resumeText` or `resumeKey` — asserted
  against the raw response body, not the parsed object
- A DynamoDB failure returns generic copy; the response is asserted NOT to
  contain the AWS exception name or the table name
- A failed GitHub scrape leaves **zero** `UpdateCommand` calls — the profile is
  never left pointing at a username whose repos could not be read
- `PUT /profile` must not contain `ADD profileVersion`; `PUT /profile/github`
  must — a name change cannot evict the plan cache, repos must
- `micOpen` is true in `interviewer-speaking`. The skill calls hiding it a
  privacy misrepresentation; this is the test that stops someone tidying it away
- `candidateFinished` arriving after `interviewerStarted` is ignored — the ASR
  FINAL and the interviewer's first audio race on one connection
- A `closed` event's specific reason survives the socket close that follows,
  rather than being overwritten with generic disconnect copy
- **`RequireProfile` never redirects on a failed fetch.** Doing so would
  re-onboard a returning candidate, and the resume re-upload would bump
  `profileVersion` and discard a good cached plan

### Pass 3 ✅ — the modules Phase 5 sits on (373 tests total)

Backend coverage **55.9 → 81.7% funcs, 75.5 → 87.9% lines**.

**A test-isolation bug was found and fixed here, and it is the one to remember.**
Bun auto-loads `apps/servers/.env`, so the pass-2 setup — which used `??=` —
inherited the developer's **real dev table, bucket and user pool**. Tests were
asserting against `prepilot-sessions-dev`, and any command escaping its mock
would have reached real infrastructure. `__tests__/setup.ts` now assigns
unconditionally, plus nonsense AWS credentials and
`AWS_EC2_METADATA_DISABLED`. Never use `??=` there.

- [x] `lib/sessions.test.ts` (52) — was **3.85%** covered
- [x] `routes/plan.test.ts` (21) — the plan cache
- [x] `lib/redact.test.ts` (27) — PII, failing closed
- [x] `lib/multipart.test.ts` (21) — the layered upload limits
- [x] `agents/planner.test.ts` (24) — JSON extraction and prompt building

Cases worth knowing:
- **All three items in `createSession` share one `expiresAt`.** Derived
  per-item, a session written across an hour would have its parts disappear
  across an hour, leaving a transcript whose META is already gone
- `loadPlannerInputs` finds items by **sort key, not position** — BatchGetItem
  returns matches unordered and omits misses
- `deleteKeyChunk` retries `UnprocessedItems` and gives up after 3, because
  BatchWriteItem reports throttling as a *successful* response that wrote nothing
- `attachPlan` and `startInterview` distinguish wrong-owner from wrong-status
  via `ReturnValuesOnConditionCheckFailure`, and still give a non-owner the
  same answer as a missing session — no enumeration oracle
- The plan cache compares the **session's** `profileVersion`, not the profile's
  current one, and stamps the cache with the version read *before* the Bedrock
  call — a profile saved mid-generation must not mark the plan fresh
- A cache read failure degrades to a miss; a cache write failure still returns
  the plan. Neither fails a request the Planner can serve
- `redactResumeText` **throws even when the deterministic pass found something**
  — returning the partial result is the silent failure it exists to prevent
- `DATE_TIME` survives redaction: employment dates are the seniority signal
- Overlapping spans merge, and are applied right-to-left so earlier
  replacements cannot invalidate later offsets
- `readPdf` validates by **magic bytes**, so a renamed executable claiming
  `application/pdf` is rejected
- The stream cap fires on a body that lies about `content-length` or omits it

### Running a short interview locally (test mode)

A real plan is 15–40 minutes by schema, so exercising the wrap-up nudges and
the hard stop costs a 40-minute sitting per attempt. Two env vars in
`apps/servers/.env` shorten the *running session* without touching the plan:

```
INTERVIEW_TEST_MODE=true
INTERVIEW_TEST_TARGET_MINUTES=6
```

At 6 minutes the schedule is wrap-up @5m15s (87.5%), final call @5m42s (95%),
hard stop @7m00s. `[interview] <sid> clock — …` logs the whole timetable at
session start, so a nudge that fired at the wrong second is distinguishable
from one that never fired.

**`PLAN_LIMITS` is deliberately untouched.** Those bounds are the product's
contract — what the Planner's prompt states, what its output is validated
against, and what every stored plan is re-validated against **on read**. A
six-minute plan in DynamoDB would fail `PlanResponseSchema` on the way out and
the interview would refuse to start. So the plan keeps a schema-valid length
and only the session is shortened, resolved once in `routes/interview.ts` and
passed to the state clock, the `ready` event, the prompt's TIME header and the
three timers.

**The nudge offsets scale only in test mode.** Production uses fixed offsets (3
min / 1 min) because a closing question takes about as long in a 15-minute
interview as in a 40-minute one. Converting production to percentages would
move the 15-minute case from a 3-minute warning to 1.9 — a behaviour change
nobody asked for, and there is a test pinning it.

Gated twice: the flag is only read outside production, and ignored there even
if set. `bun run start` sets `NODE_ENV=production`.

### Turn-taking at the end of an interview (2026-09-18)

One measured session ended with a "question" made of three interviewer turns
concatenated, scored against the transcript "thank you have a good one", and a
second record scoring "how much time is left". Both landed 0/0/0 with coaching
blaming the candidate. Four separate defects, and the first is the one that
matters:

**The compound question was not one model turn.** `ExchangeBuffer` joins
question text while `hasAnswer` is false, and Sonic takes its turn after about
two seconds of silence — so the interviewer asked, waited, asked again, closed,
and all of it accumulated into one `questionText` no answer could match. The
buffer now takes `noteTurnEnded()` and REPLACES an unanswered question rather
than joining to it. Sentence-level blocks within a single turn still join,
which is the behaviour that function exists for — there is a test pinning both.

**The phase is stated, not derived.** `interviewPhase()` names
core/wrap_up/closing from the same schedule the timers use, and it rides on
every `logExchange` and `getSessionState` result rather than only in the stream
header — a header is accurate for one instant and a stream runs six and a half
minutes. `questionsRemaining` goes with it because "wrap_up" alone could mean
"start closing" or "you are closing".

**The scoring filter had two holes**, both visible in that session. The courtesy
pattern allowed "have a good day" and not "have a good one"; the tails are now a
list. A question about the session itself — "how much time is left" — matched no
category, so `meta` exists now. The bias stays under-filtering: an unscored
pleasantry costs one odd card, a filtered real answer deletes feedback earned.

**Output filtering before playback is not possible here**, and it was asked for.
Sonic is speech-to-speech: audio reaches the candidate before the text event
reaches the server. There is no point at which a regex could suppress a question
already spoken. The buffer fix addresses the same failure at the only layer that
can act on it.

### The mock.module rule (learned the hard way, 2026-09-10)

**Never `mock.module` an internal module that another test file is the subject
of. Mock the leaf that talks to the outside world instead.**

`mock.module` is global and permanent for the process, and Bun runs every test
file in one process. `routes/plan.test.ts` mocked `agents/planner`; on Linux CI
that stub was still installed when `agents/planner.test.ts` loaded afterwards,
so all 24 of its tests ran against the stub. 23 failed. The one that passed was
the only assertion both fixtures happened to share — which is how a leaked mock
looks from the outside: mostly broken, confusingly not entirely.

**It never reproduced on Windows**, where the mock key does not match the same
way. The local suite was green through three passes while the code was wrong.
The first CI run caught it, which is the clearest argument for the pipeline
existing at all.

Fixed by `__tests__/helpers/bedrockStub.ts` — one registration of
`lib/bedrock`, shared by both files, so `agents/planner` is never replaced and
the route tests exercise the real Planner.

**Remaining hazard:** `routes/profile.test.ts` mocks `lib/github`. Safe only
because `lib/github.ts` has no test of its own. Anyone writing `github.test.ts`
must expect to be hijacked — mock `axios` there, or move the github stub into a
shared helper first.

### Pass 4 ✅ — the agents added after Phase 5 (948 tests total)

Backend **89.1% funcs / 90.2% lines**. 726 backend, 151 web, 97 shared.

Two shared stubs were extracted here, both for the mock.module rule below:
`__tests__/helpers/profileStub.ts` (web) and `ssmStub.ts` (backend). The web one
was not optional — `Header.test.tsx` and `RequireProfile.test.tsx` each
registered their own `@/lib/profile`, which only passed because neither observed
the other's state. Adding a third caller turned it into six failures at once.

`__tests__/helpers/searchStub.ts` fakes Tavily over `globalThis.fetch` rather
than mock.module'ing `lib/tavily`, deliberately: stubbing the module would
delete its timeout, its both-queries-failed rule and its response parsing from
the suite while appearing to cover them. It delegates every non-Tavily request
to the real fetch, so the route tests driving live Express servers are untouched.

Cases worth knowing:
- **`aliasedProjection` aliases every name, not the ones that look reserved.**
  `depth` took down the completion query; `role` took down the history page the
  moment a projection was added. aws-sdk-client-mock does NOT validate against
  the reserved-word list — it accepts a bare name and real DynamoDB rejects it —
  so the tests assert the STRUCTURE ("no token lacks a #"), which a new field
  cannot escape
- `toQuestionType` inherits the category on a follow-up. "Can you say more?"
  after a behavioural question is still behavioural; scored as technical the
  Evaluator marks a candidate down for not citing an algorithm in a story about
  a colleague
- The Gap repair pass demotes `strong` whose evidence names an absence, and
  every fixture is real output copied from the dev table
- The session summarizer never asks for a rewrite that already exists —
  asserted by `[NEEDS A REWRITE]` being absent from the prompt
- `trendDirection` compares half against half. One test overclaimed that this
  neutralises an outlier; it damps one. The test now says what is true

### Still untested

- [ ] **Mount-time wiring.** `testApp.ts` mounts routers without the
      `helmet` / `cors` / `AuthMiddleware` / `apiRateLimiter` chain that
      `index.ts` wraps them in. Handler behaviour is covered; the wiring is not
- [ ] `lib/sonic.ts` (735 lines) and `routes/interview.ts` (530) — the largest
      untested surface, and genuinely hard: long-lived bidirectional streams and
      renewal past the ~8-minute cap. Deliberately deferred until after Phase 5
- [ ] `lib/s3.ts` (19%), `lib/resume.ts` (13%), `lib/erasure.ts` (42%),
      `lib/cognitoAdmin.ts` (33%)
- [ ] `routes/profile.ts` is at 68% — the resume upload path is the gap
- [ ] `routes/preInterview.ts`
- [ ] The resume upload state machine in the UI (`ResumeField`)
- [ ] `packages/shared/src/schemas/auth.ts`

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
| No CD. `ci.yml` gates PRs but nothing deploys | `.github/workflows/` | High — Phase 7 |
| `GET /coach` regenerates per request; one Ministral call per page load | `apps/servers/routes/coach.ts` | Medium — cache on `USER#<uid>/COACH` |
| No link from the results page to `/coach` | `apps/web/src/pages/result.tsx` | Low |
| Editing `packages/shared` does not invalidate the dev server's cached module | Bun dev server | Medium — restart after any shared edit |
| Rate limiter is in-memory; per-task budget | `apps/servers/lib/rateLimit.ts` | Medium — options in ADR-0006 |
| Router mount-time wiring (helmet/cors/auth/rate-limit) is untested — `index.ts` calls `listen()` at module scope, so tests mount routers directly | `apps/servers/index.ts` | Medium — would need `app` exported and the listen guarded |
| The resume upload state machine in the UI is still untested | `apps/web/src/components/ResumeField.tsx` | Medium — the frontend skill asks for it |
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