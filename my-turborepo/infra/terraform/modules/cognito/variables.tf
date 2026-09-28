variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "google_client_id" {
  type        = string
  description = "Google OAuth client ID for the Cognito Google identity provider"
  sensitive   = true
}

variable "google_client_secret" {
  type        = string
  description = "Google OAuth client secret for the Cognito Google identity provider"
  sensitive   = true
}

variable "aws_acm_domain" {
  type        = string
  description = "Domain name created in AWS Certificate Management service"
  default     = "tharunsekar.xyz"
}

variable "aws_route53_zone" {
  type        = string
  description = "Public hosted zone creted in Route53"
  default     = "tharunsekar.xyz."
}


variable "aws_acm_custom_domain" {
  type        = string
  description = "Domain name created for Cognito Auth"
  default     = "auth.tharunsekar.xyz"
}

# Defaulted, because this name is safe in every environment: it is an internal
# identifier, not a resource name that could collide across accounts, and the
# group is scoped to its own user pool. It MUST match `adminGroupName` in
# apps/servers/lib/config.ts — a mismatch is not an error at boot, it silently
# means no request ever passes RequireAdmin.
variable "admin_group_name" {
  type        = string
  description = "Cognito group whose members are permitted to reach the admin API"
  default     = "admins"
}
