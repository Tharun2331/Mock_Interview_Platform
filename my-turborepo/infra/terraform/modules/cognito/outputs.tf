output "aws_cognito_domain" {
  value = aws_cognito_user_pool_domain.main
}

output "aws_route53_zone" {
  value = aws_route53_record.cognito_domain
}
