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

  # Two separate groups, never one. Custom metrics are extracted from log content,
  # so write access to the API's group is write access to the metrics its alarms
  # fire on — see the statements in the iam module.
  api_log_group_arn    = module.cloudwatch.api_log_group_arn
  worker_log_group_arn = module.cloudwatch.worker_log_group_arn
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

  # No alarm_actions in dev. An SNS topic with no confirmed subscription notifies
  # nobody while making every alarm look wired up, and dev is where a false sense
  # of coverage is cheapest to acquire and most expensive to keep. The alarms still
  # record state and still show red in the console, which is what dev needs.
  # prod should set this to a real topic ARN with a confirmed subscription.
  alarm_actions = []
}

# The evaluation queue and its dead-letter queue.
#
# Cost: effectively nothing. SQS bills per request against a 1 million/month
# free tier, and a fifteen-question interview is ~17 requests end to end. There
# is no per-hour charge, so an idle queue costs zero — unlike the NAT Gateway
# and ALB called out in infra/terraform/CLAUDE.md.
module "sqs" {
  source      = "../../modules/sqs"
  environment = var.environment
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

  # The API's origins for the CSP's connect-src. Empty until the API has a
  # public endpoint; set both the https:// and wss:// forms when it does.
  api_origins = var.api_origins
}

module "cognito" {
  source               = "../../modules/cognito"
  environment          = var.environment
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret

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
}