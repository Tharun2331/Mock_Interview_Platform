output "sessions_table_name" {
  description = "Name of the sessions DynamoDB table"
  value       = aws_dynamodb_table.sessions.name
}

output "evaluations_table_name" {
  description = "Name of the evaluations DynamoDB table"
  value       = aws_dynamodb_table.evaluations.name
}

output "quiz_history_table_name" {
  description = "Name of the quiz_history DynamoDB table"
  value       = aws_dynamodb_table.quiz_history.name
}

output "table_arns" {
  description = "ARNs of all PrepPilot DynamoDB tables"
  value = [
    aws_dynamodb_table.sessions.arn,
    aws_dynamodb_table.evaluations.arn,
    aws_dynamodb_table.quiz_history.arn,
  ]
}
