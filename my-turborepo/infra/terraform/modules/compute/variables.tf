variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "vpc_id" {
  type        = string
  description = "VPC the API server's security group belongs to"
}

variable "subnet_id" {
  type        = string
  description = "Private subnet for the API server. Use the one in the NAT instance's AZ (index 0) to avoid cross-AZ data charges."
}

variable "instance_type" {
  type        = string
  description = "Instance type for the API server. Must be Graviton (arm64): the AMI and the compiled server are arm64."
  default     = "t4g.small"
}

variable "cpu_credits" {
  type        = string
  description = "Burstable credit mode. `standard` caps the bill but throttles to baseline when credits run out; `unlimited` keeps live audio smooth under sustained load and bills surplus credits."
  default     = "standard"
}

variable "app_port" {
  type        = number
  description = "Port the server listens on. Written into the service environment as PORT, and the port CloudFront's VPC origin targets."
  default     = 8000
}

variable "server_role_name" {
  type        = string
  description = "Name of the server IAM role (iam module). The instance profile wraps it and the host policy is attached to it."
}

variable "log_group_name" {
  type        = string
  description = "API log group the CloudWatch agent ships to (cloudwatch module). The custom-metric alarms read from it."
}

variable "log_group_arn" {
  type        = string
  description = "ARN of the API log group, for scoping the agent's DescribeLogStreams"
}

variable "environment_variables" {
  type        = map(string)
  description = "The server's environment, stored as SSM parameters under /prepilot/<env>/api/env/ and loaded on every service start. Not for secrets. PORT is set from app_port."
}

# The build lives outside this module (the s3 module), so it survives the
# server being switched off. See the note on the bucket there.
variable "artifacts_bucket_id" {
  type        = string
  description = "Bucket the instance pulls the compiled server from (s3 module)"
}

variable "artifacts_bucket_arn" {
  type        = string
  description = "ARN of the artifacts bucket, for scoping the instance's s3:GetObject to the one build object"
}

variable "artifact_key" {
  type        = string
  description = "Object key of the compiled server inside the artifacts bucket (s3 module's api_artifact_key)"
}
