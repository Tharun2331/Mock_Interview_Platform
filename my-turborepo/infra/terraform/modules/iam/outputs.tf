output "server_role_arn" {
  description = "ARN of the PrepPilot server IAM role"
  value       = aws_iam_role.server.arn
}

output "bedrock_policy_arn" {
  description = "ARN of the Bedrock invoke policy"
  value       = aws_iam_policy.bedrock_invoke.arn
}

output "evaluator_worker_role_arn" {
  description = "ARN of the Evaluator worker IAM role. Attached to the worker's ECS task definition and never to the API service's — sharing one role collapses the point of splitting them."
  value       = aws_iam_role.evaluator_worker.arn
}

output "evaluator_worker_policy_arn" {
  description = "ARN of the Evaluator worker policy"
  value       = aws_iam_policy.evaluator_worker.arn
}
