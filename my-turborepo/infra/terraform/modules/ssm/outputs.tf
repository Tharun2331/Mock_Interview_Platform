output "dynamodb_table_name_parameter_name" {
  value = aws_ssm_parameter.dynamodb_table_name.name
}

output "google_client_id_parameter_name" {
  value = aws_ssm_parameter.google_client_id.name
}

output "google_client_secret_parameter_name" {
  value = aws_ssm_parameter.google_client_secret.name
}


output "tavily_api_key_parameter_name" {
  value = aws_ssm_parameter.tavily_api_key.name
}

# The ARN, not the value — reading the value here would pull a secret into
# state. Consumed by the iam module so the server role's grant is scoped to
# this one parameter rather than to the whole /prepilot/<env>/ path.
output "tavily_api_key_parameter_arn" {
  value = aws_ssm_parameter.tavily_api_key.arn
}
