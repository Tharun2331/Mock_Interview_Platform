variable "retention_days" {
  type        = number
  description = "Days to keep audit log files in S3. The trail itself is free; this bounds the storage, which is the only part that grows."
  default     = 90
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource. Carries Project, Environment and ManagedBy from the calling root."
}
