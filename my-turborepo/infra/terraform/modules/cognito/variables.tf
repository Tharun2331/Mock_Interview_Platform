variable "environment" {
  type=string
  description= "Deployment environment (dev | prod)"
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
