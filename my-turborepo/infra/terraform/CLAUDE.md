# Terraform — PrepPilot AI

Rules for anything under `infra/terraform`. Root `CLAUDE.md` still applies.

**Terraform manages every AWS resource. No console changes, ever.** If a fix
requires clicking in the console, write the `.tf` instead. A resource created
by hand is invisible to state and will be destroyed or duplicated on the next
apply.

---

## Branches and state

`dev` is for feature work, `main` for deployment. Terraform makes that split
sharper than it is for application code, because **state is real and branches
are not**.

`terraform apply` mutates live AWS and a shared state file. Two branches with
different `.tf` for the same environment do not produce two infrastructures —
they produce one, matching whichever was applied last. A plan run from `dev`
against the `dev` environment's state is authoritative regardless of what
`main` contains.

So:

- Never apply the same environment from two branches. The `environments/dev`
  root is applied from the `dev` branch; `environments/prod` is applied from
  `main`.
- Before proposing an apply, confirm which branch is checked out and which
  environment directory the command runs in. They should agree.
- `environments/global` is shared by both. Applying it from `dev` changes what
  `prod` depends on. Treat any `global` change as a change to production.
- A `plan` showing unexpected deletions often means the state was last applied
  from a different branch, not that the config is wrong. Investigate before
  applying.

---

## Layout

This repo uses **modules plus per-environment roots**. (Older planning notes say
"no modules, flat resource files" — that's stale. Modules is the actual
structure and what new work should follow.)

```
infra/terraform/
├── environments/
│   ├── global/     us-east-1 only — see below
│   ├── dev/
│   └── prod/
└── modules/
    ├── cloudfront/
    ├── cognito/
    ├── iam/
    ├── s3/
    ├── ssm/
    └── vpc/
```

Each directory under `environments/` is a **separate root module with its own
state file**. `terraform` commands run from inside one of them, never from
`infra/terraform` or from a module directory.

### Not yet built

`dynamodb`, `elasticache`, `sqs`, `alb`, `ecs` (or `compute`), `bedrock`,
`cloudwatch`. Scaffold as new modules following the conventions below rather
than dropping loose resources into an environment root.

### Why `global` exists

Some resources are region-pinned to `us-east-1` regardless of where the app
runs, and some are shared across environments:

- ACM certificates consumed by CloudFront **must** live in `us-east-1`
- Route 53 hosted zone for `tharunsekar.xyz`
- The S3 state bucket and lock table themselves

Anything in `global` is shared by `dev` and `prod`. Changing it affects both —
treat edits there as higher-risk than an environment change.

---

## Module conventions

- A module contains `main.tf`, `variables.tf`, `outputs.tf`. Every variable has
  a `type` and a `description`; give a `default` only when the default is
  genuinely safe in every environment.
- **No `provider` blocks inside modules.** Providers are configured in the
  environment root and inherited. A provider in a module makes it impossible to
  use with `for_each` or alias later.
- **No hardcoded account IDs, regions, ARNs, or bucket names.** Take them as
  variables or derive them from `data.aws_caller_identity` /
  `data.aws_region`.
- Wire modules together through **outputs**, not by re-looking-up resources with
  `data` blocks. `module.vpc.private_subnet_ids` is explicit; a data lookup by
  tag is a hidden dependency that breaks silently.
- Tag every resource that supports tags with at least `Project`, `Environment`,
  and `ManagedBy = "terraform"`. Use a shared `local.common_tags` merged in.
- Name resources for what they are, not what environment they're in — the
  environment is already in the state file and the tags.

## IAM

Least privilege, and be specific about it:

- Never `"Resource": "*"` unless the action genuinely has no resource-level
  permission. When that's the case, say so in a comment naming the action.
- Never `"Action": "s3:*"` or similar service wildcards. List the actions.
- Scope S3 to prefixes (`resumes/*`, `audio/*`), SQS to a single queue ARN,
  DynamoDB to the table plus the specific index.
- **Two ECS task roles, never shared** — one for the main API service, one for
  the Evaluator worker. Their action lists are in
  `docs/architecture/overview.md` §8. Sharing a role collapses the entire point
  of splitting the services.
- Build policies with `data "aws_iam_policy_document"`, not heredoc JSON.
  It validates at plan time and interpolates ARNs without string surgery.

## State

Remote state in S3 with locking, backend config in each environment's
`main.tf`. Distinct state keys per environment.

Never edit state by hand. `terraform state mv` and `import` are the tools, and
both go through the `ask` gate in `.claude/settings.json` — propose the command
and let a human run it.

## Secrets

- **No secrets in `.tf` files, `.tfvars`, or variable defaults.** State is
  plaintext; anything passed to Terraform is readable in the state file.
- Secret *values* are written to SSM Parameter Store out of band. Terraform
  creates the parameter and its IAM access; it does not set the value.
- Read secrets at runtime from the application, not at plan time via
  `data "aws_ssm_parameter"` — that pulls the value into state.
- `*.tfvars` and `*.tfstate` are read-denied in `.claude/settings.json`. That's
  a backstop, not permission to put secrets there.

## Workflow

`terraform fmt`, `validate`, `init`, and `plan` run freely. **`apply`,
`destroy`, `import`, and `state` require confirmation** — propose the command,
show what the plan says, and wait.

Always read the plan output before proposing an apply. A plan showing
unexpected replacement (`-/+`) on a stateful resource — RDS, ElastiCache, a
DynamoDB table — is a stop-and-discuss, not a proceed.

## Cost

Two things bill whether or not anyone uses the app:

- **NAT Gateway** — roughly $32/month per AZ plus data processing. With no ECS
  tasks running it is pure waste. During scaffold weeks, destroy and recreate
  it between sessions.
- **ElastiCache** and **ALB** — same shape of problem, smaller numbers.

When a change adds an always-on resource, or multiplies one across AZs, say so
in the same response. Don't let a second NAT Gateway land silently because the
module defaulted to one per subnet.

## Known issue: Cognito custom domain

`auth.tharunsekar.xyz` cannot be created until AWS can resolve an **A record at
the apex** of `tharunsekar.xyz`. Without it the apply fails with
`InvalidParameterException`. The unblock is a placeholder CloudFront + S3
distribution at the apex, applied before the Cognito custom domain — a genuine
ordering dependency between `global` and the Cognito module, not a transient
error to retry.