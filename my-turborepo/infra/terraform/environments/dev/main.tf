module "iam" {
  source      = "../../modules/iam"
  environment = var.environment
  aws_region  = var.aws_region
  # Wired through the module output rather than a data lookup, so the
  # dependency is explicit and the ARN cannot drift.
  uploads_bucket_arn = module.s3.uploads_bucket_arn
}

module "ssm" {
  source               = "../../modules/ssm"
  environment          = var.environment
  google_client_id     = var.google_client_id
  google_client_secret = var.google_client_secret
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