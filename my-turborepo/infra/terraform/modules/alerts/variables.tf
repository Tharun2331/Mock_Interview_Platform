variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "emails" {
  type        = list(string)
  description = "Addresses that receive alarm notifications. Empty creates no topic, and the alarms stay action-less. Each address must confirm the subscription email AWS sends before it receives anything."
  default     = []
}
