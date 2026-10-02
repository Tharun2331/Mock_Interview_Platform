output "repository_url" {
  description = "ECR repository the deploy script pushes the Evaluator image to"
  value       = aws_ecr_repository.evaluator.repository_url
}

output "function_name" {
  description = "The Evaluator function, which the deploy script points at each new image"
  value       = aws_lambda_function.evaluator.function_name
}
