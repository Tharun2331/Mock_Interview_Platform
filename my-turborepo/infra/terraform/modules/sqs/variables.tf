variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "How long a received message stays invisible to other consumers. Must comfortably exceed one Bedrock call plus the DynamoDB writes that follow, or a message is redelivered while the first attempt is still running and the duplicate pays for a second generation. Kept in sync by hand with WORKER.VISIBILITY_TIMEOUT_SECONDS in apps/servers/lib/constants.ts."
  default     = 120

  validation {
    # Below this, a slow generation plus its writes can outlast the timeout,
    # which is the one failure mode here that costs money rather than time.
    condition     = var.visibility_timeout_seconds >= 60
    error_message = "visibility_timeout_seconds must be at least 60 — a shorter window risks redelivering a message while it is still being scored, paying Bedrock twice."
  }
}

variable "message_retention_seconds" {
  type        = number
  description = "How long an unconsumed message survives. The default of four days is deliberately generous: a worker outage over a weekend should end with the backlog being scored, not silently discarded. An answer that expires here leaves a candidate with permanently missing feedback."
  default     = 345600 # 4 days
}

variable "max_receive_count" {
  type        = number
  description = "Receives before a message is routed to the DLQ. The worker leaves a message undeleted for anything a retry could fix — a DynamoDB outage, an exhausted model chain — so this is the Evaluator's retry mechanism, chosen instead of walking a model fallback chain inside a single attempt."
  default     = 3
}
