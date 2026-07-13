output "server_role_arn" {
  description = "ARN of the PrepPilot server IAM role"
  value       = aws_iam_role.server.arn
}

output "bedrock_policy_arn" {
  description = "ARN of the Bedrock invoke policy"
  value       = aws_iam_policy.bedrock_invoke.arn
}
