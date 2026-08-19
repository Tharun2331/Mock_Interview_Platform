# PrepPilot AI

AI mock-interview platform. A candidate uploads a resume and GitHub username,
then conducts a live spoken interview in the browser. Answers are scored
asynchronously and a Coach agent produces an improvement plan.

**v1 scope is Mock Interview Mode only.** Concept Mastery Mode is deferred.

---

## Read before you write

| If the task touches...          | Read first                                    |
| ------------------------------- | --------------------------------------------- |
| System design, request flow     | `docs/architecture/overview.md`               |
| Routes, WebSocket, error shapes | `docs/architecture/api.md`                    |
| DynamoDB keys, Redis, S3 layout | `docs/architecture/data-model.md`             |
| A decision that looks settled   | `docs/adr/` — check for an existing record    |
| Any UI under the web app   | `.claude/skills/preppilot-frontend/SKILL.md`  |
| Any `.tf` file                  | `infra/terraform/CLAUDE.md`                   |

This file holds rules. The architecture document holds reasoning. Don't
duplicate one into the other.

---

## Branches

- **`dev`** — all feature work. This is where you are unless told otherwise.
- **`main`** — deployment. Merged from `dev`, never committed to directly.

Consequences worth holding onto:

- Anything not yet merged to `main` is invisible to tools that read the default
  branch — including this project's repo indexing. A search returning nothing
  means "not on `main`", not "doesn't exist". Check `dev` before concluding
  something is missing.
- `main` is the deploy trigger, so a merge is a release. Terraform changes
  reaching `main` means infrastructure changes reaching the deploy pipeline.

## Repo reality

Naming is inconsistent across branches: `main` has `apps/backend`, the `dev`
branch and local tree have `apps/servers`, and older docs say `apps/server`.
**Resolve this before writing cross-package imports.** This file assumes the
`dev` names, which is where feature work happens.

```
apps/servers/       Express 5 + TypeScript. All AWS SDK calls live here.
apps/web/      Bun-native React 19. NOT Vite. NOT Next.js.
packages/ui/        Shared React components (raw TS, no build step)
packages/eslint-config/
packages/typescript-config/
```

`apps/servers` has `index.ts` at the app root, not under `src/`. Don't invent
a `src/` directory — either use the existing layout or move it deliberately and
fix `package.json` scripts in the same change.

### Does not exist yet

Planning documents describe these in present tense. They are **not on `main`**.
If a task needs one, scaffold it explicitly:

- `packages/shared` — not a workspace. Zod schemas currently live in
  `apps/servers/types.ts`. The `@shared/*` path alias does not resolve.
- `infra/terraform/` — **exists on `dev`**, with
  `modules/{cloudfront,cognito,iam,s3,ssm,vpc}` and
  `environments/{global,dev,prod}`. Not yet merged to `main`. Modules for
  `dynamodb`, `elasticache`, `sqs`, `alb`, `ecs`, `bedrock`, and `cloudwatch`
  do not exist on either branch.
- Any `@aws-sdk/*` package. Note that `@aws-sdk/client-bedrock-runtime` alone
  is not sufficient for the voice loop — Nova 2 Sonic's bidirectional stream
  needs `NodeHttp2Handler` from `@smithy/node-http-handler` as well.
- `@octokit/rest` — GitHub scraping currently uses `axios` directly
- `unpdf`, Jest, Husky, lint-staged, Prettier config, `tsconfig.base.json`

**Nothing currently blocks a bad commit.** There is no pre-commit hook and no
ESLint rule enforcing the standards below. Follow them by hand until the
tooling is wired.

### Known defects — fix, don't build around

| Where                              | Problem                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `apps/servers/package.json`         | `start` runs `bun src/index.ts`; entrypoint is `index.ts` at app root. Production start is broken. |
| `apps/web/src/App.tsx`         | `page` state never updates, so `/interview` and `/results` redirect to `/form` unconditionally. |
| `turbo.json`                        | `build.outputs` is `.next/**`, left over from `create-turbo`. Nothing emits `.next`. |
| `apps/servers/scrappers/github.ts`  | Unused `import { password } from "bun"`; repos typed `any`. |
| `apps/servers/index.ts`             | Returns `411` on validation failure. Should be `400`. |

---

## TypeScript

- `strict: true` always. Never weaken it.
- **No `any`.** Use `unknown` plus a type guard, or a generic.
- No non-null assertions (`!`). Handle null and undefined explicitly.
- No type assertions (`as`) except immediately after a runtime check that
  proves the narrowing.
- Zod schemas are the single source of truth for wire shapes. Infer types with
  `z.infer<>` rather than hand-writing a parallel interface.
- `type` for unions and utility types; `interface` for extendable object shapes.

## No hardcoded values

- No magic strings or numbers in logic — put them in `constants.ts`.
- No user-facing text inline — put it in `messages.ts`, even without i18n.
- No hardcoded config: URLs, table names, Bedrock model IDs, queue ARNs. Pull
  them from a typed config module backed by SSM Parameter Store.
- **Never read `process.env.X` outside that config module.**

## Errors and async

- Typed error classes (`class BedrockError extends Error`). Never
  `throw "string"`.
- Every async Express route is wrapped in try/catch or handled by error
  middleware. No unhandled rejections.
- For predictable failures, prefer a result-style return (`{ ok, data }`) over
  throwing.

## Structure

- Small, single-purpose functions.
- Shared types live in one place, never duplicated across apps.
- Path aliases over relative `../../../` chains — once the aliases exist.
- Pure functions where possible, so unit tests don't need mocks.

## Runtime and tooling

- **Package manager: `bun`.** Never `npm`, `yarn`, or `pnpm`. Never generate a
  `package-lock.json`.
- Turborepo drives tasks: `bun run dev`, `build`, `lint`, `check-types`.
- servers dev port **8000**. web **3000**.

## web

React 19, `react-router` v8, Tailwind v4, shadcn/ui (`new-york`, `neutral`
base, `@/` aliases). Built with `Bun.build()` and `bun-plugin-tailwind` — there
is no Vite config and no Vite plugin API available.

Microphone capture uses an `AudioWorklet` producing 16 kHz 16-bit PCM mono, not
`MediaRecorder`. `MediaRecorder` emits WebM/Opus, which Nova 2 Sonic cannot
accept. Playback is 24 kHz LPCM streamed back over the same socket.

## servers

Express 5. Note that v5 changed error handling and path matching — don't copy
Express 4 patterns.

Every request body is validated with Zod before use. AWS calls go through a
shared client module per service, never `new XClient()` inline in a handler.

**Two Bedrock paths, don't mix them:**

- Text agents (Planner, Evaluator, Coach) use `ConverseCommand` with
  `mistral.ministral-3-8b-instruct` (primary), falling back to
  `meta.llama4-scout-17b-instruct-v1:0` then `qwen.qwen3-coder-30b-a3b-v1:0`.
  Fall back to `InvokeModelCommand` only where a model doesn't support
  Converse. Stream responses on any path a user waits on.
  **These IDs are the source of truth** — they mirror
  `bedrock_text_model_ids` in `infra/terraform/modules/iam/variables.tf`, which
  is what the task role is actually permitted to invoke. Changing one without
  the other produces an `AccessDenied` at runtime.
- The live interview loop uses Amazon Nova 2 Sonic,
  `amazon.nova-2-sonic-v1:0`, via `InvokeModelWithBidirectionalStreamCommand`.
  That client needs `NodeHttp2Handler` — the default HTTP/1.1 handler cannot
  hold a duplex stream.

**Transcribe and Polly are not in the stack.** Sonic is speech-to-speech: audio
in, audio out, transcripts as `textOutput` events on the same stream. Persist
those events to DynamoDB — they are the Evaluator's and Coach's only input.
See [ADR-0005](docs/adr/0005_nova_sonic_speech_to_speech.md).

Every Sonic stream must be closed on WebSocket disconnect. It bills by open
duration, not by turns.

## Agents

Four in v1: **Planner, Mock Interview, Evaluator, Coach.** (Topic and Quiz
belong to Concept Mastery Mode and are out of scope.)

Each is a plain exported TypeScript function taking one typed input object and
returning one typed output object, with no shared mutable state between them.
Keep those signatures stable — that shape is what lets v2 wrap them as
LangGraph nodes without touching call sites.

The Mock Interview agent is the exception in shape, not in signature: it owns a
long-lived Sonic stream rather than a single request/response call. Its inputs
and outputs stay typed objects so the call site doesn't change.

## Infrastructure

Terraform manages every AWS resource. **No console changes, ever.** If a fix
requires clicking in the console, write the `.tf` instead.

Layout is **modules plus per-environment roots**: reusable modules under
`infra/terraform/modules/`, and `environments/{global,dev,prod}` as separate
root modules each with its own state. New resources go into a module, not
loose into an environment root.

Full conventions — module structure, IAM rules, state handling, apply
gating — are in `infra/terraform/CLAUDE.md`. Read it before touching any `.tf`.

Two ECS task roles, never shared: one for the main API service, one for the
Evaluator worker. Action lists in `docs/architecture/overview.md` §8. The API
role needs `bedrock:InvokeModelWithBidirectionalStream` and no longer needs
`transcribe:*` or `polly:*`. Confirm Nova 2 Sonic's region availability before
pinning the region — it is narrower than Transcribe and Polly were.

## Secrets

Production secrets come from SSM Parameter Store, read at boot. No `.env` in
production. Local `.env` files are gitignored and never committed.

## Cost

Bedrock bills per use. Nova 2 Sonic bills for as long as a bidirectional stream
is open, whether or not anyone is speaking — treat a leaked stream like a
leaked NAT Gateway. NAT Gateway bills per hour whether or not anything runs.
When a change alters token volume, audio minutes, stream duration, or
always-on infrastructure, say so in the same response — don't let it land
silently.

---

## Locked decisions

AWS-only inference (no OpenAI, no Ollama, no external LLM APIs) · no Python ·
Bun across the monorepo · Cognito only for auth · SSM only for secrets ·
Terraform for all provisioning · shadcn/ui only · Nova 2 Sonic for speech,
Ministral 3 8B for text.

## Deferred — do not suggest, design, or scaffold

Concept Mastery Mode (Topic agent, Quiz agent, flashcards, adaptive study
plans) · LangGraph, LangChain, or any agent framework · Bedrock AgentCore ·
LiveKit / WebRTC transport · Docker · local model inference · multi-tenancy ·
payments · real-time collaboration.

If a suggestion would pull in a deferred pattern, say so explicitly rather than
quietly including it.

## Working style

Targeted edits over full rewrites. State the tradeoff in a sentence or two
before recommending an approach. If a request contradicts this file or the
repo's actual state, flag the contradiction before writing code.