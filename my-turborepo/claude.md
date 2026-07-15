# Coding Standards — PrepPilot AI

## TypeScript
- `strict: true` always on (see `tsconfig.base.json`). Never weaken it.
- No `any`. Use `unknown` + a type guard, or a generic.
- No non-null assertions (`!`). Handle the null/undefined case explicitly.
- No type assertions (`as`) except right after a runtime check that proves the narrowing.
- Use Zod schemas in `packages/shared` as the single source of truth; infer types with `z.infer<>` rather than hand-writing duplicate interfaces.
- Prefer `type` for unions/utility types, `interface` for extendable object shapes.

## No hardcoded values
- No magic strings/numbers in logic — put them in a `constants.ts` or `const enum`.
- No hardcoded user-facing text inline — put in a `messages.ts` (even without i18n yet).
- No hardcoded config (URLs, table names, Bedrock model IDs) — pull from the typed config module backed by SSM Parameter Store. Never read `process.env.X` directly outside that module.

## Structure & reuse
- Small, single-purpose functions over large ones. Agents in v1 are plain TypeScript functions — no LangGraph.
- Shared types/schemas live only in `packages/shared`, never duplicated across `apps/web` and `apps/server`.
- Path aliases (`@shared/*`) instead of relative `../../../` imports.
- Pure functions where possible, for easy Jest unit testing.

## Errors & async
- Typed custom error classes (e.g. `class BedrockError extends Error`), never `throw "string"`.
- Every async Express route wrapped in try/catch or an error-handling middleware — no unhandled rejections.
- Use a typed `{ ok, data }` / result-style return for predictable failures instead of throwing.

## Enforcement (already wired, don't bypass)
- ESLint flat config (`eslint.config.js`) with `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `no-floating-promises` set to `error`.
- Prettier (`.prettierrc.json`) for formatting — don't hand-format.
- Husky + lint-staged blocks commits that fail lint/format.

## Project constraints (do not suggest otherwise)
- All AI runs through AWS Bedrock — no OpenAI, no Ollama, no external LLM APIs.
- No Python in v1 — agents are TypeScript functions in the Express server.
- No LangGraph/LangChain until v2.
- Terraform manages all AWS resources — no manual console changes.
- Bun as package manager across the monorepo.
- Auth is Cognito only. Secrets in SSM only — no `.env` in production.
- shadcn/ui only for components.