module "iam" {
  source      = "../../modules/iam"
  environment = var.environment
  aws_region  = var.aws_region
}
