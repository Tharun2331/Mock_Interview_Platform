variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "bucket_id" {
  type        = string
  description = "ID of the S3 frontend bucket to serve"
}

variable "bucket_arn" {
  type        = string
  description = "ARN of the S3 frontend bucket (for the OAC bucket policy)"
}

variable "bucket_regional_domain_name" {
  type        = string
  description = "Regional domain name of the S3 frontend bucket (CloudFront origin)"
}

variable "aliases" {
  type        = list(string)
  description = "Domain aliases served by this distribution"
  default     = ["tharunsekar.xyz"]
}

variable "acm_domain" {
  type        = string
  description = "Primary domain name of the issued ACM certificate (us-east-1)"
  default     = "tharunsekar.xyz"
}

variable "route53_zone_name" {
  type        = string
  description = "Public hosted zone name (trailing dot)"
  default     = "tharunsekar.xyz."
}
