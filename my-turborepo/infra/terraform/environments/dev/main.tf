module "iam" {
  source      = "../../modules/iam"
  environment = var.environment
  aws_region  = var.aws_region
  # Wired through the module output rather than a data lookup, so the
  # dependency is explicit and the ARN cannot drift.
  uploads_bucket_arn = module.s3.uploads_bucket_arn
  sessions_table_arn = module.dynamodb.table_arn
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