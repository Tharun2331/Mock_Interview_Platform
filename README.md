# PrepPilot AI

> ⚠️ **Work in progress.** This project is under active development and not yet feature-complete or production-ready. Expect breaking changes, missing features, and incomplete documentation.

PrepPilot AI is a mock interview platform that uses AWS Bedrock to generate and run AI-driven interview prep sessions, built as a Bun/Turborepo monorepo.

## Tech stack

- **Monorepo**: Turborepo + Bun workspaces
- **Frontend**: `apps/web` (React, shadcn/ui)
- **Backend**: `apps/servers` (Express, TypeScript)
- **AI**: AWS Bedrock (no OpenAI/Ollama/other external LLM providers)
- **Auth**: AWS Cognito
- **Config/secrets**: AWS SSM Parameter Store
- **Infra**: Terraform (`infra/terraform`) — VPC, IAM, DynamoDB modules across `dev`/`prod`/`global` environments
- **Shared code**: `packages/shared` (Zod schemas as source of truth for types)

## Project structure

```
my-turborepo/
├── apps/
│   ├── servers/        # Express API (routes, Bedrock agents, scrapers)
│   └── web/             # React frontend
├── packages/
│   ├── shared/           # Shared Zod schemas & types
│   ├── ui/                # shadcn/ui components
│   ├── eslint-config/
│   └── typescript-config/
└── infra/
    └── terraform/         # AWS infra (VPC, IAM, DynamoDB)
```

## Getting started

```bash
bun install
bun run dev
```

Other useful scripts (run from `my-turborepo/`):

```bash
bun run build         # build all apps/packages
bun run lint          # lint all workspaces
bun run check-types   # typecheck all workspaces
bun run format        # prettier --write
```

## Status

Currently implemented (in progress, may be incomplete):
- Basic Express server scaffold with Bedrock integration
- Interview planner agent (`apps/servers/agents/planner.ts`)
- GitHub profile scraper for candidate context
- Pre-interview and plan API routes
- Terraform modules for VPC, IAM, and DynamoDB

Not yet done:
- Cognito auth wiring
- Full frontend interview flow
- End-to-end AI interview session handling

## Conventions

Coding standards and project constraints are documented in [`my-turborepo/claude.md`](my-turborepo/claude.md).
