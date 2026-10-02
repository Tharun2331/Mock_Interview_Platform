output "instance_id" {
  description = "The API server instance. Connect with `aws ssm start-session --target <id>`."
  value       = aws_instance.api.id
}

output "instance_arn" {
  description = "ARN of the API server instance, which CloudFront's VPC origin targets"
  value       = aws_instance.api.arn
}

output "private_ip" {
  value = aws_instance.api.private_ip
}

output "private_dns" {
  description = "Private DNS name of the API server, the CloudFront VPC origin's origin domain"
  value       = aws_instance.api.private_dns
}

output "security_group_id" {
  description = "The API server's security group. The CloudFront VPC origin ingress rule attaches here."
  value       = aws_security_group.api.id
}

output "app_port" {
  value = var.app_port
}

output "artifacts_bucket" {
  description = "Bucket the compiled server is uploaded to, at the key in artifact_uri"
  value       = aws_s3_bucket.artifacts.id
}

output "artifact_uri" {
  description = "Where a deploy uploads the compiled server before running /opt/prepilot/bin/deploy on the instance"
  value       = "s3://${aws_s3_bucket.artifacts.id}/${local.artifact_key}"
}
