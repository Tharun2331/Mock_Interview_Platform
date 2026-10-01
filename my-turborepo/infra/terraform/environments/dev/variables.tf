variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "dev"
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

variable "api_origins" {
  type        = list(string)
  description = "Origins of the PrepPilot API that the web app's Content-Security-Policy allows, in both schemes, e.g. [\"https://api-dev.tharunsekar.xyz\", \"wss://api-dev.tharunsekar.xyz\"]."
  default     = []
}

variable "alert_emails" {
  type        = list(string)
  description = "Addresses notified when a CloudWatch alarm fires. Set it in a gitignored tfvars file. Each address must click the confirmation email AWS sends."
  default     = []
}

variable "app_origins" {
  type        = list(string)
  description = "Origins dev's web app is served from. Sign-in callbacks and sign-out redirects are allowed to these and nothing else."
  default     = ["http://localhost:3000"]
}

variable "api_server_enabled" {
  type        = bool
  description = "Run the API server and the NAT instance it needs (~$20/month together). Off between test sessions."
  default     = false
}

