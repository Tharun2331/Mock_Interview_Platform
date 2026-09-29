variable "bedrock_monthly_limit_usd" {
  type        = number
  description = "Monthly Amazon Bedrock spend that triggers the Bedrock budget's alerts."
}

variable "total_monthly_limit_usd" {
  type        = number
  description = "Monthly spend across the whole account that triggers the account budget's alerts."
}

variable "alert_emails" {
  type        = list(string)
  description = "Email subscribers for every notification. Empty creates the budgets without notifications."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every budget. Carries Project, Environment and ManagedBy from the calling root."
}
