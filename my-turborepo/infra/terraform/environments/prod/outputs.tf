# The same outputs as dev, which the deploy scripts read by name:
# apps/web/scripts/deploy.ts and apps/servers/scripts/deploy-evaluator.ts.

output "cognito_user_pool_id" {
  description = "The ID of prod's Cognito user pool"
  value       = module.cognito.cognito_user_pool_id
}

output "cognito_user_pool_client_id" {
  description = "The ID of prod's Cognito user pool client"
  value       = module.cognito.cognito_user_pool_client_id
}

output "cognito_domain" {
  description = "Hosted-UI domain the API's Google sign-in redirects through"
  value       = module.cognito.custom_domain
}

# Membership is not managed by Terraform. To make yourself an admin:
#   aws cognito-idp admin-add-user-to-group \
#     --user-pool-id $(terraform output -raw cognito_user_pool_id) \
#     --username <your email> --group-name $(terraform output -raw admin_group_name)
output "admin_group_name" {
  description = "Cognito group whose members reach the admin API"
  value       = module.cognito.admin_group_name
}

output "sessions_table_name" {
  description = "Name of prod's interview sessions table"
  value       = module.dynamodb.table_name
}

output "uploads_bucket_id" {
  description = "Name of prod's candidate uploads bucket"
  value       = module.s3.uploads_bucket_id
}

output "eval_queue_url" {
  description = "URL of prod's evaluation queue"
  value       = module.sqs.eval_queue_url
}

output "eval_dlq_name" {
  description = "Name of prod's evaluation dead-letter queue"
  value       = module.sqs.eval_dlq_name
}

output "alarm_names" {
  description = "Every CloudWatch alarm created for prod"
  value       = module.cloudwatch.alarm_names
}

# Null while api_server_enabled is false.
output "api_server_instance_id" {
  description = "The API server instance. Connect with `aws ssm start-session --target <id>`."
  value       = one(module.compute[*].instance_id)
}

# Set while the server is off, so a build can be uploaded before it boots.
output "api_artifact_uri" {
  description = "Where a deploy uploads the compiled server before running /opt/prepilot/bin/deploy on the instance"
  value       = module.s3.api_artifact_uri
}

# Fixed, so the site can be published whether or not the API is running.
output "api_url" {
  description = "The API's public base URL"
  value       = "https://${local.api_domain}"
}

output "frontend_bucket_id" {
  description = "Bucket the built web app is uploaded to"
  value       = module.s3.bucket_id
}

output "frontend_distribution_id" {
  description = "The web app's distribution, invalidated after each deploy"
  value       = module.cloudfront.distribution_id
}

output "evaluator_repository_url" {
  description = "ECR repository the Evaluator image is pushed to"
  value       = module.evaluator.repository_url
}

output "evaluator_function_name" {
  description = "The Evaluator Lambda function"
  value       = module.evaluator.function_name
}

output "turnstile_site_key" {
  description = "Public Turnstile site key the sign-up page renders its widget with"
  value       = local.turnstile_site_key
}
