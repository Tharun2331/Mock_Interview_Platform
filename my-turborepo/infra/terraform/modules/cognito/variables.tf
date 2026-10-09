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

variable "app_origins" {
  type        = list(string)
  description = "Origins the web app is served from in THIS environment, without a trailing slash, e.g. [\"http://localhost:3000\"] for dev or [\"https://preppilot.tharunsekar.xyz\"] for prod. Each becomes an allowed sign-in callback (<origin>/callback) and sign-out URL. Never list another environment's origin here."
}

variable "api_origins" {
  type        = list(string)
  description = "Origins the API is served from in THIS environment, without a trailing slash, e.g. [\"http://localhost:8000\", \"https://api-dev.tharunsekar.xyz\"]. Each becomes an allowed Google sign-in callback (<origin>/api/v1/auth/google/callback) on the server client. Never list another environment's origin here."
}

variable "block_plus_addressing" {
  type        = bool
  description = "Refuse native sign-ups whose address has a + tag (name+1@example.com). Every tag lands in one inbox, so leaving it open lets one mailbox create unlimited accounts, each with its own free interviews."
  default     = true
}

variable "extra_blocked_email_domains" {
  type        = list(string)
  description = "Disposable-mail domains to refuse on top of the list built into pre_sign_up/index.mjs. Subdomains of each are refused too."
  default     = []
}


variable "turnstile_mode" {
  type        = string
  description = "Turnstile check on native sign-ups: off, monitor (verify and log, never refuse) or enforce. Roll out through monitor first — see pre_sign_up/index.mjs."
  default     = "off"

  validation {
    condition     = contains(["off", "monitor", "enforce"], var.turnstile_mode)
    error_message = "turnstile_mode must be off, monitor or enforce."
  }
}

variable "turnstile_hostnames" {
  type        = list(string)
  description = "Hostnames a Turnstile token may have been solved on: the sign-up page's own. Must match the widget's hostname list in the Cloudflare dashboard."
  default     = []
}
