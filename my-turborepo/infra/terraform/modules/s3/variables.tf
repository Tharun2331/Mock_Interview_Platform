variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "audio_retention_days" {
  type        = number
  description = "Days before objects under audio/ expire. Transcripts in DynamoDB are the durable record, so the raw PCM is a debugging aid rather than product data."
  default     = 30
}
