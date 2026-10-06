variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

# Prod's OWN Google OAuth client, not dev's: its own consent screen and secret,
# so a leaked dev credential cannot reach prod accounts. Set both in the
# gitignored secrets.auto.tfvars — see secrets.auto.tfvars.example.
variable "google_client_id" {
  type        = string
  description = "Google OAuth client ID for prod's Cognito Google identity provider"
  sensitive   = true
}

variable "google_client_secret" {
  type        = string
  description = "Google OAuth client secret for prod's Cognito Google identity provider"
  sensitive   = true
}

variable "alert_emails" {
  type        = list(string)
  description = "Addresses notified when a CloudWatch alarm fires. Set it in the gitignored secrets.auto.tfvars. Each address must click the confirmation email AWS sends."
  default     = []
}

variable "app_origins" {
  type        = list(string)
  description = "Origins prod's web app is served from. Sign-in callbacks and sign-out redirects are allowed to these and nothing else — no localhost in prod."
  default     = ["https://preppilot.tharunsekar.xyz"]
}

# Switchable, like dev, by decision (2026-10-05): ~$20/month together while on.
# While off, the site itself still loads (S3 + CloudFront) but every API call
# fails, so sign-in, the profile and interviews are unavailable.
variable "api_server_enabled" {
  type        = bool
  description = "Run prod's API server, the NAT instance it needs, and the API's CloudFront distribution. While off the site loads but its API is down."
  default     = false
}
