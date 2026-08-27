variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "point_in_time_recovery_enabled" {
  type        = bool
  description = "Continuous backups with restore to any second in the last 35 days. Billed per GB of table size. An interview cannot be replayed, so in prod this is the only thing standing between a bad write and permanently lost transcripts."
}

variable "deletion_protection_enabled" {
  type        = bool
  description = "Blocks table deletion until explicitly disabled. No default on purpose: dev is torn down routinely so protection is pure friction there, while its absence in prod means one `terraform destroy` erases every interview ever recorded. Each environment states its own answer."
}

variable "ttl_attribute_name" {
  type        = string
  description = "Attribute holding a Unix-epoch expiry, enabling automatic item deletion. Null disables TTL, which is correct for prod — session data is the product, not a cache. TTL deletes consume no write capacity, which makes it the cheapest way to keep dev fixtures from accumulating."
  default     = null
}
