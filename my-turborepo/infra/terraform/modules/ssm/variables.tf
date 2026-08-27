variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "dynamodb_table_name" {
  type        = string
  description = "Name of the interview sessions table, from the dynamodb module. Published as runtime config so the server never derives it from NODE_ENV."
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
