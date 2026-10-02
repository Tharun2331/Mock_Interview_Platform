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

# API build artifacts — consumed by the compute module (where its instance pulls
# the build from) and by whoever uploads a build.
output "artifacts_bucket_id" {
  description = "Bucket the compiled API server is uploaded to"
  value       = aws_s3_bucket.artifacts.id
}

output "artifacts_bucket_arn" {
  description = "ARN of the artifacts bucket, for scoping the instance's read"
  value       = aws_s3_bucket.artifacts.arn
}

output "api_artifact_key" {
  description = "Object key of the compiled API server inside the artifacts bucket"
  value       = local.api_artifact_key
}

output "api_artifact_uri" {
  description = "Where a deploy uploads the compiled server before running /opt/prepilot/bin/deploy on the instance"
  value       = "s3://${aws_s3_bucket.artifacts.id}/${local.api_artifact_key}"
}
