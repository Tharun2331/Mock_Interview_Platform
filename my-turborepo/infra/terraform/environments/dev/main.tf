module "dynamodb" {
  source      = "../../modules/dynamodb"
  environment = var.environment
  enable_pitr = false
}

module "iam" {
  source              = "../../modules/iam"
  environment         = var.environment
  aws_region          = var.aws_region
  dynamodb_table_arns = module.dynamodb.table_arns
}
