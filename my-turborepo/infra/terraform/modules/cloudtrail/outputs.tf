output "trail_arn" {
  description = "ARN of the account audit trail."
  value       = aws_cloudtrail.audit.arn
}

output "bucket_name" {
  description = "Bucket holding the audit log files. Validate them with `aws cloudtrail validate-logs --trail-arn <trail_arn> --start-time <iso>`."
  value       = aws_s3_bucket.trail.id
}
