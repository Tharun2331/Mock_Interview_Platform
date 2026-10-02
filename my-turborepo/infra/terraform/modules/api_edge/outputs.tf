output "api_url" {
  description = "The API's public base URL. The web app is built with this as BUN_PUBLIC_API_URL."
  value       = "https://${var.api_domain}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.api.id
}

output "distribution_domain_name" {
  value = aws_cloudfront_distribution.api.domain_name
}
