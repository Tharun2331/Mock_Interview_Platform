# PrepPilot AI — Phase Tracker
> Local only — gitignored. Updated as work progresses.
> Last updated: 2026-08-19

---

## Current position: mid Phase 2

Auth and the infrastructure foundation are done. The data layer (DynamoDB,
resume parsing) has not been started, and no Bedrock call is made anywhere yet.

| Phase | Status |
|-------|--------|
| 1 — Foundation + Planner | ✅ Complete (1 item deferred) |
| 2 — Resume + Auth + Database | 🟡 ~50% — auth done, data layer untouched |
| 3 — WebSocket + Speech | 🔸 ~10% — VPC only |
| 4 — Sonic end-to-end | ⬜ Not started |
| 5 — Evaluator + SQS | ⬜ Not started |
| 6 — Coach + RAG | ⬜ Not started |
| 7 — Deploy + CI/CD | 🔸 ~20% — CloudFront/SSM/build already landed early |

**Next highest-leverage step:** DynamoDB single-table module. No VPC dependency,
and everything in Phases 3–6 writes to it.

---

## Phase 1 — Weeks 1–2: Foundation + Planner Agent ✅

### Backend
- [x] Turborepo monorepo scaffold (`apps/servers`, `apps/web`, `packages/shared`)
- [x] `packages/shared` — `PreInterviewBody`/`PreInterviewResponse`, `PlanRequestSchema`/`PlanResponseSchema`, auth schemas
  - **Reshaped 2026-08-19:** the plan schemas were Concept Mastery leftovers (`topic`/`goal` → `recommendedPath`), which made the Planner emit study paths instead of interview plans. Now `{targetRole, resumeText?, repos}` → `{focusAreas, questionMix, difficulty, reasoning}`, matching the architecture. Vestigial `mode: z.enum(["mock"])` dropped
- [x] `lib/bedrock.ts` — `BedrockRuntimeClient` singleton + `converseText()` fallback helper, **live as of 2026-08-19**
- [x] `lib/config.ts` — typed config module (single `process.env` boundary)
- [x] `lib/messages.ts` — user-facing strings
- [x] `agents/planner.ts` — Planner agent, **real `ConverseCommand` call as of 2026-08-19** (was a hardcoded fixture)
- [x] `routes/preInterview.ts` — `POST /api/v1/pre-interview` (GitHub scrape via axios + Zod-validated response)
- [x] `routes/plan.ts` — `POST /api/v1/plan`
- [x] `index.ts` — clean entry point, no inline routes
- [ ] Replace axios GitHub call with `@octokit/rest` — package installed (`^22.0.1`), **imported nowhere**; route still uses axios

### Frontend
- [x] React 19 + BrowserRouter with `/form`, `/interview`, `/results` routes
- [x] `Form.tsx` — GitHub URL input, POST to backend
- [x] shadcn/ui components (Button, Input, Card, Label, Select, Textarea, Sonner, Field, Separator)
- [x] ~~Navigation bug: `Form.tsx` never calls `SetPage` after submit~~ — **fixed 2026-08-19**; posts, Zod-parses the response, navigates to `/interview` with the repos in router state
- [ ] `Interview.tsx` — stub, one heading (built in Phase 3)
- [ ] `Result.tsx` — stub, one heading (built in Phase 4)

### Terraform
- [x] `environments/global/` — S3 state bucket + versioning, IAM user `prepilot-terraform`, access key
- [x] `environments/global/` — migrated local → S3 backend (`use_lockfile = true`)
- [x] `modules/iam/` — `prepilot-server-role-{env}` + Bedrock invoke policy (scoped to 3 model ARNs)
- [x] `environments/dev/` — IAM module applied, role + policy live in AWS
- [ ] `environments/prod/` — five empty files, not wired (Phase 7)

### Codebase hygiene
- [x] `claude.md` — coding standards + architecture doc
- [x] `.gitignore` — Terraform state, tfvars, `.claude.local.md`, `.env`
- [x] Removed dead files: `APITester.tsx`, `hooks/useFetch.tsx`
- [x] ~~`scrappers/github.ts` dead stub~~ — **deleted 2026-08-19**
- [x] Removed concept mastery code: `quiz_history` table, planner concept path, `z.enum(["concept","mock"])` → `["mock"]`
- [ ] `packages/ui/` — unused `create-turbo` leftovers; app uses `apps/web/src/components/ui/` instead
- [ ] `/api/hello` demo routes still in `apps/web/src/index.ts`

---

## Phase 2 — Weeks 3–4: Resume + Auth + Database 🟡

**Auth half: done. Data half: not started.**

### Backend
- [x] JWT validation middleware — `lib/cognitoAuth.ts`, verifies locally against Cognito JWKS via `aws-jwt-verify`, attaches `req.user`, JWKS cached in memory
- [ ] Install `@octokit/rest`, replace axios GitHub call in `routes/preInterview.ts` — installed, not wired
- [x] Resume upload + parse — **done 2026-08-19**. `unpdf` installed; **`multer` deliberately not used** — `lib/multipart.ts` bridges Express's Node `IncomingMessage` to a web `Request` so Bun's own `formData()` parses it
- [x] `lib/s3.ts` — `S3Client` singleton + `putResume()`, raw PDF stored at `resumes/<uid>/<sid>.pdf`
- [x] Update `routes/preInterview.ts` — accepts JSON *or* multipart on one endpoint; GitHub scrape and PDF parse overlap via `Promise.all`. Returns `sessionId` + optional `resume` text, which feeds `PlanRequest.resumeText`
- [ ] Frontend: file input in `form.tsx` + switch to `FormData` (route still accepts JSON, so nothing is broken meanwhile)
- [ ] **Untested until applied:** the S3 write path. Everything else is verified; `UPLOADS_BUCKET` must be set from `terraform output uploads_bucket_id`
- [ ] `lib/dynamo.ts` — `DynamoDBDocumentClient` singleton
- [x] `lib/constants.ts` — created 2026-08-19 with Bedrock tuning + planner bounds. Still needs DynamoDB table name and key prefixes when that module lands. Model IDs live in `lib/config.ts` (the SSM-backed boundary), not here

### Terraform
- [x] `modules/cognito/` — user pool, app client, Google IdP, custom domain `auth.tharunsekar.xyz`
- [x] Wire cognito into `environments/dev/main.tf`
- [ ] DynamoDB single table with GSI on SK — **no module or `.tf` exists**
  - PK: `SESSION#<sid>`, SK: `META` / `ANSWER#<qId>` / `EVAL#<qId>` / `COACH`
  - GSI: SK → PK for user history lookup (`USER#<uid>` → `SESSION#<sid>`)
- [ ] Update `modules/iam/` — add DynamoDB + S3 read/write to server role (scoped to session prefixes). Currently **Bedrock-only**

### Frontend
- [x] Amplify setup — configured once in `frontend.tsx`, Cognito + Google OAuth
- [x] Login / signup flow — custom shadcn forms with Amplify (`signup`, `signin`, `confirm`, `callback`)
- [x] `lib/auth.tsx` — `AuthProvider` reporting `loading` / `authenticated` / `unauthenticated` from Hub events
- [x] Route guards — `RequireAuth` and `RedirectIfAuthenticated`
- [x] `lib/api.ts` — authenticated axios client; interceptor attaches the Cognito **access** token per request
- [ ] Resume file input in `Form.tsx` — `multipart/form-data` upload

---

## Phase 2.5 — Security hardening ✅ (unplanned, completed 2026-08-19)

Not in the original plan. Logged because it is real work and a reviewer will look
for it.

- [x] Client attaches JWT on every API call (`lib/api.ts` interceptor + `fetchAuthSession` refresh)
- [x] `helmet()`, JSON body cap (16kb), `trust proxy 1` (one hop — not `true`, which allows `X-Forwarded-For` spoofing)
- [x] Per-user rate limiting keyed on the Cognito `sub` (`lib/rateLimit.ts`)
- [x] GitHub URL validated by real `URL` parsing + username allowlist — rejects `github.com@evil.com`, homoglyph hosts, `%2e%2e` traversal
- [x] 5s timeout on the upstream GitHub call
- [x] Cognito errors mapped to safe copy; `error.message` never surfaced — closes the sign-in user-enumeration oracle
- [x] Plaintext password removed from router history state; confirm page uses Amplify `autoSignIn()`
- [x] Multi-origin CORS; fails loudly at boot on an empty allowlist
- [x] Build and runtime both fail loudly on missing `BUN_PUBLIC_*` instead of inlining `""`
- [x] `payload.scope` optional-guard in auth middleware (was a spurious-401 crash)
- [x] All user-facing copy centralised in `lib/messages.ts`

**Carry-forward:** the rate limiter uses an in-memory store, so the budget is
per ECS task. Must move to a Redis store when the service scales past one task —
`ratelimit:<uid>:<minute>`, lands with the Phase 3 Redis work.

---

## Phase 3 — Weeks 5–6: WebSocket + Nova Sonic 🔸

> **Rewritten per [ADR-0005](docs/adr/0005_nova_sonic_speech_to_speech.md).**
> Transcribe and Polly are **out of the stack**. Nova 2 Sonic is speech-to-speech:
> audio in, audio out, transcripts arrive as `textOutput` events on the same
> stream. The previous version of this phase described the superseded design.

### Backend
- [ ] Switch Express from HTTP-only to WebSocket support (`ws` or `express-ws`)
- [ ] `routes/interview.ts` — WebSocket handler
  - Open one Sonic bidirectional stream per WS connection
  - Relay 16 kHz PCM audio chunks: client → Sonic
  - Stream 24 kHz LPCM audio back to the client
  - Persist `textOutput` events to DynamoDB — they are the Evaluator's and Coach's **only** input
  - Update Redis (turn count, current question index)
- [ ] `lib/sonic.ts` — Bedrock client with `NodeHttp2Handler` from `@smithy/node-http-handler` (the default HTTP/1.1 handler cannot hold a duplex stream)
- [ ] `lib/redis.ts` — `ioredis` client singleton
- [ ] `agents/mockInterview.ts` — owns the long-lived Sonic stream
- [ ] **Close every Sonic stream on WS disconnect** — it bills by open duration, not by turns

### Frontend
- [ ] `hooks/useRecorder.ts` — `AudioWorklet` producing 16 kHz 16-bit PCM mono. **Not `MediaRecorder`** (emits WebM/Opus, which Sonic cannot accept)
- [ ] `getUserMedia` with `echoCancellation` / `noiseSuppression` / `autoGainControl` — mic stays open during playback, so without AEC the model hears itself
- [ ] `hooks/useInterview.ts` — state machine: `idle` / `requesting-permission` / `permission-denied` / `recording` / `processing` / `interviewer-speaking` / `interrupting` / `error`
- [ ] `Interview.tsx` — transcript, live input-level meter, always-reachable stop, mic indicator visible during `interviewer-speaking`

### Terraform
- [x] `modules/vpc/` — VPC, public + private subnets, NAT, route tables, SGs (225 lines, wired into dev)
- [ ] ElastiCache Redis — cluster, subnet group, security group

---

## Phase 4 — Week 7: Sonic end-to-end ⬜

> Polly is gone; Sonic returns audio directly. This phase is now about wiring the
> candidate context into the stream and persisting turns.

### Backend
- [ ] System prompt from candidate background (resume + GitHub summary from Planner)
- [x] Replace the `agents/planner.ts` fixture with a real `ConverseCommand` call — **done 2026-08-19**, verified against live Bedrock (~2.1s, schema-valid output, fallback chain exercised)
- [ ] Persist running transcript to DynamoDB each turn (`ANSWER#<qId>` items)

### Frontend
- [ ] Buffer and schedule 24 kHz LPCM playback through Web Audio (no `<audio>` blob)
- [ ] `Result.tsx` — scores + improvement plan display

---

## Phase 5 — Week 8: Evaluator + SQS ⬜

### Backend
- [ ] `agents/evaluator.ts` — scores correctness / clarity / depth (0–10 each), `ConverseCommand`
- [ ] `lib/sqs.ts` — `SQSClient` singleton
- [ ] After interview ends: enqueue each Q&A pair to `eval-queue`
- [ ] Fargate Spot worker (`apps/worker/`) — polls SQS, runs Evaluator, writes `EVAL#<qId>`
  - Completion counter: `UpdateItem ADD completedCount 1`
  - When count hits total questions: trigger Coach agent
  - Idempotent: keyed by `questionId`, written with `PutItem` (SQS is at-least-once)

### Terraform
- [ ] `sqs` module — `eval-queue`, DLQ, redrive policy (`maxReceiveCount: 3`)
- [ ] `ecs` module — cluster, main Fargate service + Spot worker service
- [ ] Second IAM role for the Evaluator worker — `bedrock:InvokeModel` + DynamoDB write on `EVAL#*` only. **Never share with the API role**
- [ ] Resume + audio buckets (`resumes/<uid>/<sid>.pdf`, `audio/<sid>/<qId>`) — the existing `s3` module is the **frontend** bucket only

---

## Phase 6 — Week 9: Coach + RAG ⬜

### Backend
- [ ] `agents/coach.ts` — reads all `EVAL#*` for the session, retrieves from Bedrock KB, generates improvement plan
- [ ] `lib/bedrockKB.ts` — `BedrockAgentRuntimeClient` singleton
- [ ] Write plan to DynamoDB under `SESSION#<sid> / COACH`
- [ ] `GET /api/v1/coach/:sessionId` — client polls for the plan

### Terraform
- [ ] `bedrock` module — Knowledge Base + S3 data source (study documents bucket)
- [ ] Update IAM — `bedrock:Retrieve` on the KB ARN

---

## Phase 7 — Weeks 10–12: Deploy + CI/CD + Observability 🔸

Partly done already — CloudFront, SSM and the production build landed during the
auth work rather than waiting for this phase.

### Terraform
- [x] `modules/cloudfront/` — distribution + apex A record `tharunsekar.xyz`, OAC to the private frontend bucket
- [x] `modules/s3/` — private frontend bucket with OAC
- [x] `modules/ssm/` — Google OAuth client id/secret as SecureString at `/prepilot/dev/google/*`
- [ ] Extend `ssm` to cover **all** runtime config, not just Google creds
- [ ] `cloudwatch` module — log groups for both ECS services, alarms (error rate, latency, DLQ depth)
- [ ] `environments/prod/` — mirror all dev modules with prod-grade values (PITR, Multi-AZ Redis, deletion protection)

### CI/CD
- [ ] `.github/workflows/deploy.yml` — on push to `main`: build → ECR → ECS rolling update
- [ ] `.github/workflows/pr-checks.yml` — on PR: type-check, lint, test
- [x] Wire `check-types` for `apps/web` and `apps/servers` — **fixed 2026-08-19**; `turbo run check-types` now covers 4 workspaces instead of 2

### Frontend
- [x] `build.ts` — production `Bun.build()` to `dist/`, fails on missing `BUN_PUBLIC_*`
- [ ] Upload `dist/` to S3 on deploy
- [ ] Presigned URL flow for resume/audio — browser uploads direct to S3

---

## Known issues / open items

| Issue | File | Priority |
|-------|------|----------|
| Editing `packages/shared` does not invalidate the dev server's cached module — symbols resolve `undefined` until restart | Bun dev server | Medium — restart `bun run dev` after any shared edit |
| Rate limiter store is in-memory; budget is per ECS task | `apps/servers/lib/rateLimit.ts` | Medium — must move to Redis before scaling |
| GitHub scraping uses axios instead of `@octokit/rest` | `apps/servers/routes/preInterview.ts` | Medium — functional but wrong library per claude.md |
| `turbo.json` `build.outputs` is `.next/**`, leftover from `create-turbo` | `turbo.json` | Low — nothing emits `.next` |
| `packages/ui/` unused; app uses its own `components/ui/` | `packages/ui/` | Low — delete |
| `/api/hello` demo routes still present | `apps/web/src/index.ts` | Low — delete |
| `environments/prod/` — five empty files | `infra/terraform/environments/prod/` | Low — not needed until Phase 7 |

**Resolved 2026-08-19:** Form.tsx navigation bug · dead `scrappers/github.ts` ·
`frontend.tsx` non-null assertion · `environments/global` migrated to S3 backend ·
`apps/servers` `start` script pointed at a nonexistent `src/` (verified: old target
returned `FileNotFound`, new one bundles 342 modules) · `apps/servers` `build`
script pointed at a nonexistent `build.ts` — **removed**, since Bun runs the
TypeScript entrypoint directly and the server produces no bundle ·
`check-types` missing from both apps.

---

## Terraform structure note

`claude.md §7` shows flat per-service `.tf` files inside the environment
directory. **Reality diverged and the module pattern won**: every service is a
reusable module under `infra/terraform/modules/` (`iam`, `ssm`, `s3`,
`cloudfront`, `cognito`, `vpc`), composed by `environments/dev/main.tf`.

Keep doing that — new resources go into a module, not loose into an environment
root. `infra/terraform/CLAUDE.md` documents the conventions; `claude.md §7` is
the stale one and should be corrected to match.
