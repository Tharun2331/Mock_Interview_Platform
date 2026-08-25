variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "aws_region" {
  type        = string
  description = "AWS region where Bedrock models are accessed"
}

variable "bedrock_text_model_ids" {
  type        = list(string)
  description = "Foundation models the text agents (Planner, Evaluator, Coach) may invoke, in fallback order. Verified ACTIVE in us-east-1 on 2026-08-19."
  default = [
    "mistral.ministral-3-8b-instruct",
    "meta.llama4-scout-17b-instruct-v1:0",
    "qwen.qwen3-coder-30b-a3b-v1:0",
  ]
}

variable "uploads_bucket_arn" {
  type        = string
  description = "ARN of the candidate uploads bucket, from the s3 module. Object permissions are scoped to prefixes within it, never the whole bucket."
}

variable "upload_prefixes" {
  type        = list(string)
  description = "Key prefixes inside the uploads bucket the server may read and write. Anything outside these is denied by omission."
  default     = ["resumes", "audio"]
}

variable "bedrock_speech_model_id" {
  type        = string
  description = "Speech-to-speech model for the live interview loop. Confirm region availability before changing aws_region — unlike the text models this one has no fallback, and a mismatch fails at runtime rather than at apply."
  default     = "amazon.nova-2-sonic-v1:0"
}
