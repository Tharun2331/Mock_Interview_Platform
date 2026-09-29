output "bedrock_budget_name" {
  description = "Name of the Bedrock monthly budget."
  value       = aws_budgets_budget.bedrock.name
}

output "total_budget_name" {
  description = "Name of the whole-account monthly budget."
  value       = aws_budgets_budget.total.name
}
