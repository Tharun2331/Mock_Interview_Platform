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

# Not a secret — a String, not a SecureString. It lives here because
# data-model.md §1 requires the table name to be read from SSM at boot rather
# than derived from NODE_ENV: deriving it means a misconfigured environment
# silently reads and writes the wrong environment's interviews.
resource "aws_ssm_parameter" "dynamodb_table_name" {
  name        = "/prepilot/${var.environment}/dynamodb/table_name"
  description = "Name of the single interview sessions table"
  type        = "String"
  value       = var.dynamodb_table_name

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
