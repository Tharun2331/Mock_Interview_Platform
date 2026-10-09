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
  description = "Domain aliases served by this distribution. Each one other than the apex also gets a Route 53 A record."
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

variable "api_origins" {
  type        = list(string)
  description = "Origins of the PrepPilot API the web app may connect to, both schemes: e.g. [\"https://api.example.com\", \"wss://api.example.com\"]. Empty until the API is deployed, which means the CSP blocks every API call, so set it with the API."
  default     = []
}

variable "csp_enforce" {
  type        = bool
  description = "Enforce the Content-Security-Policy (true) or send it as Content-Security-Policy-Report-Only (false) while proving a change against the real app. Enforced by default."
  default     = true
}


variable "create_apex_record" {
  type        = bool
  description = "Point the apex (acm_domain) at this distribution. Exactly one environment may own it — dev does. Turn off everywhere else, or the apply fails on a duplicate record."
  default     = true
}
