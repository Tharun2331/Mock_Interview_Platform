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
