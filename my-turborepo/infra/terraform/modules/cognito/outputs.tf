output "aws_cognito_domain" {
  value = aws_cognito_user_pool_domain.main
}

output "aws_route53_zone" {
  value = aws_route53_record.cognito_domain
}


output "cognito_user_pool_id" {
  description = "The ID of the Cognito User Pool"
  value       = aws_cognito_user_pool.pool.id
}

output "cognito_user_pool_client_id" {
  description = "The ID of the Cognito User Pool Client"
  value       = aws_cognito_user_pool_client.client.id
}