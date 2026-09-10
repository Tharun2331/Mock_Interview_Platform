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

# The server reads this from SSM at boot. Exposed here as well so local
# development can set it without a console lookup, the same way UPLOADS_BUCKET
# is handled today.
output "sessions_table_name" {
  description = "Name of the interview sessions table"
  value       = module.dynamodb.table_name
}
# Consumed by the API service as EVAL_QUEUE_URL and by the Evaluator worker's
# poller. Exposed for the same reason as the two above: local development sets
# it from `terraform output` rather than copying a URL out of the console.
output "eval_queue_url" {
  description = "URL of the evaluation queue"
  value       = module.sqs.eval_queue_url
}

# Nothing writes to the DLQ directly — it is a redrive target. Its name is here
# for the CloudWatch alarm dimension once that module exists: depth above zero
# means answers are going unscored, which is otherwise invisible.
output "eval_dlq_name" {
  description = "Name of the evaluation dead-letter queue"
  value       = module.sqs.eval_dlq_name
}

# Attached to the Evaluator worker's ECS task definition, never to the API
# service's. Sharing one role collapses the point of splitting them.
output "evaluator_worker_role_arn" {
  description = "ARN of the Evaluator worker IAM role"
  value       = module.iam.evaluator_worker_role_arn
}
