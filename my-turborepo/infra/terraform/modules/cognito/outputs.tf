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
output "cognito_user_pool_arn" {
  description = "ARN of the Cognito User Pool. Consumed by the IAM module to scope AdminDeleteUser and ListUsers to this pool and no other."
  value       = aws_cognito_user_pool.pool.arn
}

output "admin_group_name" {
  description = "Cognito group whose members reach the admin API. Set as ADMIN_GROUP_NAME on the API service — the server's default matches, so this exists to make a change to the variable propagate rather than drift."
  value       = aws_cognito_user_group.admins.name
}

# The hosted-UI domain as a plain string (auth.<domain>), for the web build's
# BUN_PUBLIC_COGNITO_DOMAIN. Without it a build falls back to dev's domain, so
# a prod bundle would send Google sign-in to the dev pool.
output "custom_domain" {
  description = "Hosted-UI domain the web app's Google sign-in redirects through"
  value       = aws_cognito_user_pool_domain.main.domain
}
