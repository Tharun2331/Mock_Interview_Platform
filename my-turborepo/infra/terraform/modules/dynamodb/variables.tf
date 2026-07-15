variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "billing_mode" {
  type        = string
  description = "DynamoDB billing mode"
  default     = "PAY_PER_REQUEST"
}

variable "enable_pitr" {
  type        = bool
  description = "Enable point-in-time recovery"
  default     = false
}
