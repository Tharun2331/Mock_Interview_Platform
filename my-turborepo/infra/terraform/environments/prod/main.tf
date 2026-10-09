# Production. The same modules as environments/dev; this file states only where
# prod differs, and why. Applied from `master` only (infra/terraform/CLAUDE.md).
#
# What differs from dev:
#   - its own hostnames, all single-level so the existing *.tharunsekar.xyz
#     certificate covers them: preppilot. (web), api-prod. (API), auth-prod.
#     (Cognito's hosted UI)
#   - the apex stays dev's: prod creates no apex record
#   - data protection on: DynamoDB point-in-time recovery and deletion
#     protection, no TTL; the Cognito pool's deletion protection (the module
#     default)
#   - its own Google OAuth client and its own Turnstile widget and secret
#
# First rollout, once — the same ordering dev needed:
#   1. terraform apply -target=module.evaluator.aws_ecr_repository.evaluator -target=module.s3
#   2. push the Evaluator image (bun run deploy:evaluator prod) and upload the
#      server build to the api_artifact_uri output
#   3. terraform apply -var api_server_enabled=true
#   4. bun run deploy prod (apps/web)

locals {
  web_domains = ["preppilot.tharunsekar.xyz"]
  web_origin  = join(",", [for domain in local.web_domains : "https://${domain}"])
  api_domain  = "api-prod.tharunsekar.xyz"

  # api.tharunsekar.xyz is taken: an API Gateway custom domain outside this
  # project's Terraform. auth.tharunsekar.xyz is dev's pool's.
  auth_domain = "auth-prod.tharunsekar.xyz"

  # Same budget as dev, for the same reason — see environments/dev/main.tf.
  evaluator_timeout_seconds = 150

  # Rolled out the way dev was: monitor until the trigger's log shows
  # "turnstile verified on preppilot.tharunsekar.xyz" for a real sign-up, then
  # enforce.
  turnstile_mode = "monitor"

  # Prod's own widget (hostname preppilot.tharunsekar.xyz only). Public by
  # design; the secret is in SSM at /prepilot/prod/turnstile/secret_key.
  turnstile_site_key = "0x4AAAAAAFO6HaOAJ-VEJNUE"
}

module "iam" {
  source                = "../../modules/iam"
  environment           = var.environment
  aws_region            = var.aws_region
  uploads_bucket_arn    = module.s3.uploads_bucket_arn
  sessions_table_arn    = module.dynamodb.table_arn
  cognito_user_pool_arn = module.cognito.cognito_user_pool_arn
  eval_queue_arn        = module.sqs.eval_queue_arn
  guardrail_arn         = module.guardrail.guardrail_arn
  api_log_group_arn     = module.cloudwatch.api_log_group_arn
  worker_log_group_arn  = module.cloudwatch.worker_log_group_arn
}

# Its own guardrail, never dev's: tuning dev must not change prod (ADR-0010).
#
# Enforcing from its first apply, skipping a prod detect phase — a deliberate
# call (2026-10-08) on dev's evidence: a full fifteen-answer interview under
# enforce with no refusals, and the one false positive seen (the immigration
# topic on a posting's work-eligibility line) already removed. The risk taken
# is that the first real posting to trip a filter is refused rather than
# logged. If that happens, set "detect", apply, restart the API — then tune.
module "guardrail" {
  source      = "../../modules/guardrail"
  environment = var.environment
  mode        = "enforce"
}

module "cloudwatch" {
  source                 = "../../modules/cloudwatch"
  environment            = var.environment
  metric_dimension_value = var.environment
  eval_dlq_name          = module.sqs.eval_dlq_name
  alarm_actions          = module.alerts.alarm_actions
}

module "alerts" {
  source      = "../../modules/alerts"
  environment = var.environment
  emails      = var.alert_emails
}

module "sqs" {
  source      = "../../modules/sqs"
  environment = var.environment

  visibility_timeout_seconds = 6 * local.evaluator_timeout_seconds
}

# Not behind api_server_enabled, as in dev: it bills nothing while idle.
module "evaluator" {
  source      = "../../modules/evaluator"
  environment = var.environment

  role_arn        = module.iam.evaluator_worker_role_arn
  eval_queue_arn  = module.sqs.eval_queue_arn
  log_group_name  = module.cloudwatch.worker_log_group_name
  timeout_seconds = local.evaluator_timeout_seconds

  environment_variables = {
    NODE_ENV                    = "production"
    APP_ENV                     = var.environment
    BEDROCK_TEXT_MODEL_IDS      = "mistral.ministral-3-8b-instruct"
    SESSIONS_TABLE              = module.dynamodb.table_name
    COGNITO_USER_POOL_ID        = module.cognito.cognito_user_pool_id
    COGNITO_USER_POOL_CLIENT_ID = module.cognito.cognito_user_pool_client_id
    CORS_ORIGIN                 = local.web_origin
    BEDROCK_GUARDRAIL_ID        = module.guardrail.guardrail_id
    BEDROCK_GUARDRAIL_VERSION   = module.guardrail.guardrail_version
    EVAL_MAX_RECEIVES           = tostring(module.sqs.max_receive_count)
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

  # Session data is the product. Without deletion protection one `terraform
  # destroy` erases every recorded interview; without PITR there is no way
  # back from a bad write.
  point_in_time_recovery_enabled = true
  deletion_protection_enabled    = true

  # No TTL in prod, deliberately — dev's expiry exists to clear test sessions,
  # and here an expiry attribute set by accident would delete real ones.
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

  # The apex is dev's. A second owner fails on a duplicate record.
  create_apex_record = false

  api_origins = ["https://${local.api_domain}", "wss://${local.api_domain}"]
}

module "cognito" {
  source               = "../../modules/cognito"
  environment          = var.environment
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

  # Single-level under *.tharunsekar.xyz, so the existing certificate covers it.
  # Cognito needs the parent (the apex) to resolve; dev's apex record does that.
  aws_acm_custom_domain = local.auth_domain

  app_origins = var.app_origins
  # Google's code returns to the API (ADR-0011). No localhost in prod.
  api_origins = ["https://${local.api_domain}"]

  # Prod's widget lists only the prod site, so no localhost here.
  turnstile_mode      = local.turnstile_mode
  turnstile_hostnames = local.web_domains

  # deletion_protection is left at the module's default, on.
}

module "vpc" {
  source              = "../../modules/vpc"
  environment         = var.environment
  enable_nat_instance = var.api_server_enabled
}

module "compute" {
  count  = var.api_server_enabled ? 1 : 0
  source = "../../modules/compute"

  environment = var.environment
  vpc_id      = module.vpc.vpc_id
  subnet_id   = module.vpc.private_subnet_ids[0]

  server_role_name = module.iam.server_role_name
  log_group_name   = module.cloudwatch.api_log_group_name
  log_group_arn    = module.cloudwatch.api_log_group_arn

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
    CORS_ORIGIN                 = local.web_origin
    # Reaches the running server only on a service restart — see dev.
    BEDROCK_GUARDRAIL_ID      = module.guardrail.guardrail_id
    BEDROCK_GUARDRAIL_VERSION = module.guardrail.guardrail_version
    # Cookie-based auth routes (ADR-0011) — see dev.
    COGNITO_DOMAIN    = module.cognito.custom_domain
    API_PUBLIC_ORIGIN = "https://${local.api_domain}"
    WEB_APP_ORIGIN    = "https://${local.web_domains[0]}"
  }

  secret_environment_variables = {
    COGNITO_USER_POOL_CLIENT_SECRET = module.cognito.cognito_user_pool_client_secret
  }
}

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
