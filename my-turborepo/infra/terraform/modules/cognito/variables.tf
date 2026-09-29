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

variable "threat_protection_mode" {
  type        = string
  description = "Cognito threat protection: OFF, AUDIT (score and log risky sign-ins) or ENFORCED (block them). Anything but OFF moves the pool to the PLUS feature tier, which is billed per monthly active user."
  default     = "OFF"

  validation {
    condition     = contains(["OFF", "AUDIT", "ENFORCED"], var.threat_protection_mode)
    error_message = "threat_protection_mode must be OFF, AUDIT or ENFORCED."
  }
}

variable "deletion_protection" {
  type        = bool
  description = "Refuse to delete the user pool. Deleting it deletes every account, so this defaults on; turn it off only to deliberately tear an environment down."
  default     = true
}
