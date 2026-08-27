# Consumed by the ssm module (written as the runtime config parameter) and by
# the server at boot. Never derived from NODE_ENV on the application side.
output "table_name" {
  description = "Name of the single interview sessions table"
  value       = aws_dynamodb_table.sessions.name
}

# Consumed by the iam module to scope the server role's permissions. Passed as
# an output rather than reconstructed from the name, so a rename cannot leave
# the policy pointing at a table that no longer exists.
output "table_arn" {
  description = "ARN of the interview sessions table"
  value       = aws_dynamodb_table.sessions.arn
}
