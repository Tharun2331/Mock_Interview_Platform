output "server_role_arn" {
  description = "ARN of the PrepPilot server IAM role (dev)"
  value       = module.iam.server_role_arn
}

output "bedrock_policy_arn" {
  description = "ARN of the Bedrock invoke policy (dev)"
  value       = module.iam.bedrock_policy_arn
}

output "sessions_table_name" {
  description = "DynamoDB sessions table name (dev)"
  value       = module.dynamodb.sessions_table_name
}

output "evaluations_table_name" {
  description = "DynamoDB evaluations table name (dev)"
  value       = module.dynamodb.evaluations_table_name
}

output "quiz_history_table_name" {
  description = "DynamoDB quiz_history table name (dev)"
  value       = module.dynamodb.quiz_history_table_name
}
