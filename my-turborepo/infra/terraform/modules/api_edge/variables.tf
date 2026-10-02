variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "api_domain" {
  type        = string
  description = "Hostname the API is served at, e.g. api-dev.tharunsekar.xyz. Must be covered by the ACM certificate."
}

variable "acm_domain" {
  type        = string
  description = "Primary domain name of the issued ACM certificate (us-east-1). Its *.domain SAN covers api_domain."
  default     = "tharunsekar.xyz"
}

variable "route53_zone_name" {
  type        = string
  description = "Public hosted zone the API record goes in"
  default     = "tharunsekar.xyz."
}

variable "vpc_id" {
  type        = string
  description = "VPC the API server runs in. Where AWS creates the CloudFront VPC origins security group."
}

variable "instance_arn" {
  type        = string
  description = "ARN of the API server instance (compute module), the VPC origin's target"
}

variable "instance_private_dns" {
  type        = string
  description = "Private DNS name of the API server instance, the distribution's origin domain"
}

variable "instance_security_group_id" {
  type        = string
  description = "The API server's security group, which gets the rule admitting CloudFront"
}

variable "app_port" {
  type        = number
  description = "Port the API server listens on"
}
