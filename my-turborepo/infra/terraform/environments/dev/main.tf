module "iam" {
  source      = "../../modules/iam"
  environment = var.environment
  aws_region  = var.aws_region
  # Wired through the module output rather than a data lookup, so the
  # dependency is explicit and the ARN cannot drift.
  uploads_bucket_arn    = module.s3.uploads_bucket_arn
  sessions_table_arn    = module.dynamodb.table_arn
  cognito_user_pool_arn = module.cognito.cognito_user_pool_arn
  eval_queue_arn        = module.sqs.eval_queue_arn
  guardrail_arn         = module.guardrail.guardrail_arn

  # Two separate groups, never one. Custom metrics are extracted from log content,
  # so write access to the API's group is write access to the metrics its alarms
  # fire on — see the statements in the iam module.
  api_log_group_arn    = module.cloudwatch.api_log_group_arn
  worker_log_group_arn = module.cloudwatch.worker_log_group_arn
}

# The text agents' Bedrock Guardrail (ADR-0010). Enforcing on dev since
# 2026-10-07, after a detect phase of real interviews and three injection tests:
# filters block, PII is anonymized, and the denied topics exist. Prod follows
# only once dev shows no false positives on ordinary interviews.
#
# Cost: no always-on charge. Billed per 1,000 characters scanned, per policy, on
# the user turn and the model's reply only. Enforce adds the denied topics'
# charge to every scan.
module "guardrail" {
  source      = "../../modules/guardrail"
  environment = var.environment
  mode        = "enforce"
}

# Log groups and alarms.
#
# Ordered after the metrics exist in the application, deliberately: writing alarms
# against metric names before anything emits them means guessing at names, and a
# guessed name does not fail — the alarm sits in INSUFFICIENT_DATA looking
# configured. Every metric named in this module is one apps/servers/lib/metrics.ts
# actually emits.
#
# **What works today and what does not.** The DLQ alarm reads an AWS-published
# metric and is live now. The other four read custom metrics that arrive via EMF
# log lines, and nothing writes to the log group until an `ecs` module points a
# task at it — so they will apply cleanly and sit in INSUFFICIENT_DATA until then.
# That is expected, not a misconfiguration.
#
# Cost: log ingestion and storage only, and storage is the one that recurs —
# hence the explicit 30-day retention rather than CloudWatch's "never expire"
# default. Alarms are $0.10/month each, so five is $0.50. Custom metrics are
# $0.30/metric/month, and the dimension design in lib/constants.ts is what keeps
# that count in the low tens rather than unbounded — read the note there before
# adding a dimension.
module "cloudwatch" {
  source      = "../../modules/cloudwatch"
  environment = var.environment

  # What the service sets APP_ENV to, which is what the metric dimension carries.
  # Separate from `environment` on purpose — see the variable's description — but
  # the same value here, because dev's service reports as "dev".
  metric_dimension_value = var.environment

  eval_dlq_name = module.sqs.eval_dlq_name

  # Alarm notifications go to the alerts module's topic, which exists only when
  # alert_emails is set. With no emails this is an empty list: the alarms still
  # record state and show red in the console, but notify nobody, which is the
  # honest default rather than a topic that looks wired up and is not.
  alarm_actions = module.alerts.alarm_actions
}

# The evaluation queue and its dead-letter queue.
#
# Cost: effectively nothing. SQS bills per request against a 1 million/month
# free tier, and a fifteen-question interview is ~17 requests end to end. There
# is no per-hour charge, so an idle queue costs zero — unlike the NAT Gateway
# and ALB called out in infra/terraform/CLAUDE.md.
# Email notifications for the alarms above. See the module for the
# subscription-confirmation step.
module "alerts" {
  source      = "../../modules/alerts"
  environment = var.environment
  emails      = var.alert_emails
}

module "sqs" {
  source      = "../../modules/sqs"
  environment = var.environment

  # Lambda refuses an SQS trigger whose visibility timeout is shorter than the
  # function's timeout, and AWS recommends 6x so a throttled or retried batch is
  # not redelivered while still in flight. Derived, so the two cannot drift.
  visibility_timeout_seconds = 6 * local.evaluator_timeout_seconds
}

# The Evaluator worker (ADR-0009). NOT behind api_server_enabled: it bills
# nothing while idle, and whenever an interview has run there are answers in
# the queue that need a consumer.
module "evaluator" {
  source      = "../../modules/evaluator"
  environment = var.environment

  role_arn        = module.iam.evaluator_worker_role_arn
  eval_queue_arn  = module.sqs.eval_queue_arn
  log_group_name  = module.cloudwatch.worker_log_group_name
  timeout_seconds = local.evaluator_timeout_seconds

  environment_variables = {
    NODE_ENV = "production"
    APP_ENV  = var.environment
    # One model, no fallback chain: SQS redrive is the retry. See the note at
    # the top of apps/servers/worker.ts.
    BEDROCK_TEXT_MODEL_IDS = "mistral.ministral-3-8b-instruct"
    SESSIONS_TABLE         = module.dynamodb.table_name
    # Required at import by lib/config, which the worker shares with the API:
    # Cognito ids for the auth module, and an https origin because production
    # mode refuses to boot without one. The worker uses neither.
    COGNITO_USER_POOL_ID        = module.cognito.cognito_user_pool_id
    COGNITO_USER_POOL_CLIENT_ID = module.cognito.cognito_user_pool_client_id
    CORS_ORIGIN                 = local.web_origin
    # Takes effect on the next invocation after apply.
    BEDROCK_GUARDRAIL_ID      = module.guardrail.guardrail_id
    BEDROCK_GUARDRAIL_VERSION = module.guardrail.guardrail_version
    # From the queue itself, so the worker's idea of "last attempt" cannot
    # drift from the redrive policy that enforces it.
    EVAL_MAX_RECEIVES = tostring(module.sqs.max_receive_count)
  }
}

module "ssm" {
  source               = "../../modules/ssm"
  environment          = var.environment
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
  dynamodb_table_name  = module.dynamodb.table_name
}

module "dynamodb" {
  source      = "../../modules/dynamodb"
  environment = var.environment

  # dev is torn down and rebuilt routinely, so both protections are friction
  # here rather than safety. prod must set both to true — without deletion
  # protection a single `terraform destroy` erases every recorded interview,
  # and without PITR there is no way back from a bad write.
  point_in_time_recovery_enabled = false
  deletion_protection_enabled    = false

  # dev only. TTL deletes cost no write capacity, so this is the cheapest way
  # to stop test sessions accumulating. Never set in prod: session data is the
  # product, and an expiry attribute set by accident would delete it silently.
  #
  # This was enabled here long before anything wrote the attribute, which made
  # it inert — TTL ignores items that have no matching attribute, so nothing
  # ever expired. `sessionExpiresAt()` in apps/servers/lib/sessions.ts now
  # populates it. The name is a contract between the two: rename it on one side
  # and expiry stops silently rather than failing.
  ttl_attribute_name = "expiresAt"
}

module "s3" {
  source      = "../../modules/s3"
  environment = var.environment
}

module "cloudfront" {
  source                      = "../../modules/cloudfront"
  environment                 = var.environment
  bucket_id                   = module.s3.bucket_id
  bucket_arn                  = module.s3.bucket_arn
  bucket_regional_domain_name = module.s3.bucket_regional_domain_name
  aliases                     = local.web_domains

  # The API's origins for the CSP's connect-src, both schemes: REST calls and
  # the interview WebSocket. Independent of api_server_enabled on purpose, so
  # toggling the server does not republish the security-headers function.
  api_origins = ["https://${local.api_domain}", "wss://${local.api_domain}"]
}

locals {
  # Where dev's web app is served (the web distribution's aliases) and where its
  # API is. Separate hostnames because the web distribution's Free plan cannot
  # use a VPC origin — see the api_edge module.
  #
  # preppilot-dev is the app's home; preppilot.tharunsekar.xyz is reserved for
  # prod. The bare apex no longer serves the app (removed 2026-10-08), but its
  # A record STAYS — the cloudfront module still creates it (create_apex_record),
  # because Cognito needs tharunsekar.xyz to resolve before it will create or
  # update auth.tharunsekar.xyz or prod's auth-prod. A visit to the apex now
  # reaches CloudFront with no matching alias and is refused; DNS resolving is
  # all Cognito needs.
  web_domains = ["preppilot-dev.tharunsekar.xyz"]
  web_origin  = join(",", [for domain in local.web_domains : "https://${domain}"])
  api_domain  = "api-dev.tharunsekar.xyz"

  # Worst case for one answer: three Evaluator attempts at Bedrock's 30s
  # request timeout, the session summary's call, and the DynamoDB writes —
  # about 125s, if Bedrock hangs. A typical answer takes 2-5s.
  evaluator_timeout_seconds = 150

  # Turnstile (step 5). Rolled out through `monitor`, which verified and logged
  # without refusing; enforced once the trigger's log showed "turnstile
  # verified on preppilot-dev.tharunsekar.xyz" for a real sign-up (2026-10-05).
  # A sign-up without a valid token — a direct call to Cognito's SignUp API —
  # is now refused.
  turnstile_mode = "enforce"

  # Public by design: it is rendered into the sign-up page. The secret half is
  # in SSM at /prepilot/dev/turnstile/secret_key, never here.
  turnstile_site_key = "0x4AAAAAAFM7wOo4Dycm7rLa"
}

module "cognito" {
  source               = "../../modules/cognito"
  environment          = var.environment
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

  # Dev's pages only. The production origin belongs to the prod pool's client.
  app_origins = var.app_origins
  # Where Google's code is returned to the server client (ADR-0011): the local
  # server for `bun dev`, and the deployed dev API.
  api_origins = ["http://localhost:8000", "https://${local.api_domain}"]

  # Turnstile on native sign-ups. Hostnames are the sign-up page's own, from
  # the same list as CORS, plus localhost for `bun --hot`; they must match the
  # widget's list in the Cloudflare dashboard.
  turnstile_mode      = local.turnstile_mode
  turnstile_hostnames = concat(local.web_domains, ["localhost"])

  # NOTE: intentionally NO depends_on = [module.cloudfront]. The apex record
  # (created by module.cloudfront) only needed to exist for the FIRST creation
  # of the custom domain. A module-level depends_on defers this module's data
  # sources (ACM cert) whenever CloudFront has any pending change, which makes
  # certificate_arn "known after apply" and forces the user pool domain to be
  # replaced (auth downtime). If ever rebuilding from scratch, apply
  # module.cloudfront first, then module.cognito.
}

module "vpc" {
  source      = "../../modules/vpc"
  environment = var.environment

  # The NAT instance exists only to give the API server egress, so it follows
  # the same switch.
  enable_nat_instance = var.api_server_enabled
}

# The API server (ADR-0008). Off by default in dev: together with the NAT
# instance it is ~$20/month whether or not anyone is testing. Turn it on for a
# session and off afterwards, the same discipline infra/terraform/CLAUDE.md
# describes for every always-on resource.
module "compute" {
  count  = var.api_server_enabled ? 1 : 0
  source = "../../modules/compute"

  environment = var.environment
  vpc_id      = module.vpc.vpc_id
  # Index 0 is the NAT instance's AZ; the other would pay cross-AZ transfer.
  subnet_id = module.vpc.private_subnet_ids[0]

  server_role_name = module.iam.server_role_name
  log_group_name   = module.cloudwatch.api_log_group_name
  log_group_arn    = module.cloudwatch.api_log_group_arn

  # Outside this switch on purpose, so the last build survives the server
  # being turned off. See the artifacts bucket in the s3 module.
  artifacts_bucket_id  = module.s3.artifacts_bucket_id
  artifacts_bucket_arn = module.s3.artifacts_bucket_arn
  artifact_key         = module.s3.api_artifact_key

  environment_variables = {
    APP_ENV                     = var.environment
    AWS_REGION                  = var.aws_region
    COGNITO_USER_POOL_ID        = module.cognito.cognito_user_pool_id
    COGNITO_USER_POOL_CLIENT_ID = module.cognito.cognito_user_pool_client_id
    SESSIONS_TABLE              = module.dynamodb.table_name
    UPLOADS_BUCKET              = module.s3.uploads_bucket_id
    EVAL_QUEUE_URL              = module.sqs.eval_queue_url
    # The page calling the API. Cross-origin, since the API has its own
    # hostname. Production mode refuses anything not https://, so localhost
    # cannot be listed here.
    CORS_ORIGIN = local.web_origin
    # Read when the service starts, so a new guardrail version reaches the
    # server only after a restart. The old version is kept until then
    # (skip_destroy in the guardrail module).
    BEDROCK_GUARDRAIL_ID      = module.guardrail.guardrail_id
    BEDROCK_GUARDRAIL_VERSION = module.guardrail.guardrail_version
    # The cookie-based auth routes (ADR-0011). The server's own public origin
    # and the hosted-UI domain build Google's authorize and callback URLs; the
    # web origin is where a finished sign-in lands.
    COGNITO_DOMAIN    = module.cognito.custom_domain
    API_PUBLIC_ORIGIN = "https://${local.api_domain}"
    WEB_APP_ORIGIN    = "https://${local.web_domains[0]}"
  }

  secret_environment_variables = {
    COGNITO_USER_POOL_CLIENT_SECRET = module.cognito.cognito_user_pool_client_secret
  }
}

# CloudFront in front of the API server, on its own pay-as-you-go distribution.
# Follows the same switch: the VPC origin targets the instance, so it cannot
# outlive it. Creating or deleting a distribution takes several minutes, which
# makes toggling the server slower than before.
module "api_edge" {
  count  = var.api_server_enabled ? 1 : 0
  source = "../../modules/api_edge"

  environment                = var.environment
  api_domain                 = local.api_domain
  vpc_id                     = module.vpc.vpc_id
  instance_arn               = module.compute[0].instance_arn
  instance_private_dns       = module.compute[0].private_dns
  instance_security_group_id = module.compute[0].security_group_id
  app_port                   = module.compute[0].app_port
}