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

# Consumed by the admin surface as ADMIN_GROUP_NAME. The server defaults to the
# same value, so this exists so that changing the Terraform variable propagates
# rather than silently leaving nobody an admin.
#
# Membership is NOT managed by Terraform — see the note on aws_cognito_user_group
# in the cognito module. To become an admin:
#
#   aws cognito-idp admin-add-user-to-group \
#     --user-pool-id $(terraform output -raw cognito_user_pool_id) \
#     --username <your email> \
#     --group-name $(terraform output -raw admin_group_name)
#
# The group claim lands on the ACCESS token, so an existing session must sign out
# and back in — or refresh — before the admin routes stop returning 404.
output "admin_group_name" {
  description = "Cognito group whose members reach the admin API"
  value       = module.cognito.admin_group_name
}

# The awslogs destination for the API task definition, once the ecs module exists.
# Also the reason the custom-metric alarms currently have no data: EMF metrics are
# extracted at log ingestion, and nothing writes here yet.
output "api_log_group_name" {
  description = "Log group the API service writes to (and the path by which EMF metrics become CloudWatch metrics)"
  value       = module.cloudwatch.api_log_group_name
}

output "worker_log_group_name" {
  description = "Log group the Evaluator worker writes to. Separate from the API's so the worker role cannot write into the stream the API's metric alarms are extracted from."
  value       = module.cloudwatch.worker_log_group_name
}

# For a post-apply smoke check. Expect the DLQ alarm in OK and the four
# custom-metric alarms in INSUFFICIENT_DATA until ECS ships logs — that is the
# correct state today, not a misconfiguration.
output "alarm_names" {
  description = "Every CloudWatch alarm created for this environment"
  value       = module.cloudwatch.alarm_names
}

# Null while api_server_enabled is false.
output "api_server_instance_id" {
  description = "The API server instance. Connect with `aws ssm start-session --target <id>`."
  value       = one(module.compute[*].instance_id)
}

output "api_artifact_uri" {
  description = "Where a deploy uploads the compiled server before running /opt/prepilot/bin/deploy on the instance"
  value       = one(module.compute[*].artifact_uri)
}
