variable "bedrock_monthly_limit_usd" {
  type        = number
  description = "Monthly Amazon Bedrock spend (text agents plus Nova 2 Sonic) that triggers the Bedrock budget alerts. A threshold, not a cap: AWS Budgets notifies and never stops spend."
  default     = 50
}

variable "total_monthly_limit_usd" {
  type        = number
  description = "Monthly spend across the whole account that triggers the account budget alerts. Catches the always-on costs Bedrock does not: a forgotten NAT Gateway, an ALB, a runaway log group."
  default     = 100
}

variable "budget_alert_emails" {
  type        = list(string)
  description = "Addresses AWS Budgets emails when a threshold is crossed. Empty means the budgets are created and visible in the console but notify nobody, so set this in a gitignored tfvars file before relying on it."
  default     = []
}
