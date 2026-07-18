resource "aws_ssm_parameter" "google_client_id" {
  name        = "/prepilot/${var.environment}/google/client_id"
  description = "Google OAuth client ID (Cognito identity provider)"
  type        = "SecureString"
  value       = var.google_client_id

  tags = {
    Project     = "prepilot"
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "google_client_secret" {
  name        = "/prepilot/${var.environment}/google/client_secret"
  description = "Google OAuth client secret (Cognito identity provider)"
  type        = "SecureString"
  value       = var.google_client_secret

  tags = {
    Project     = "prepilot"
    Environment = var.environment
  }
}
