output "server_role_arn" {
  description = "ARN of the PrepPilot server IAM role (dev)"
  value       = module.iam.server_role_arn
}

output "bedrock_policy_arn" {
  description = "ARN of the Bedrock invoke policy (dev)"
  value       = module.iam.bedrock_policy_arn
}


output "cognito_user_pool_id" {
  description = "The ID of the Cognito User Pool"
  value       = module.cognito.cognito_user_pool_id
}

output "cognito_user_pool_client_id" {
  description = "The ID of the Cognito User Pool Client"
  value       = module.cognito.cognito_user_pool_client_id
}

# Consumed by the server as UPLOADS_BUCKET. Exposed here so runtime config comes
# from state rather than being copied out of the console, where a typo surfaces
# only as a failed upload.
output "uploads_bucket_id" {
  description = "Name of the candidate uploads bucket (resumes and interview audio)"
  value       = module.s3.uploads_bucket_id
}