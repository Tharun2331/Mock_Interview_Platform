# Frontend bucket — consumed by the cloudfront module as its origin.
output "bucket_id" {
  description = "Name of the frontend static-asset bucket"
  value       = aws_s3_bucket.frontend.id
}

output "bucket_arn" {
  description = "ARN of the frontend static-asset bucket"
  value       = aws_s3_bucket.frontend.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name of the frontend bucket, for the CloudFront origin"
  value       = aws_s3_bucket.frontend.bucket_regional_domain_name
}

# Uploads bucket — consumed by the iam module to scope object permissions, and
# by the server at runtime to write resumes.
output "uploads_bucket_id" {
  description = "Name of the candidate uploads bucket (resumes and interview audio)"
  value       = aws_s3_bucket.uploads.id
}

output "uploads_bucket_arn" {
  description = "ARN of the candidate uploads bucket"
  value       = aws_s3_bucket.uploads.arn
}
