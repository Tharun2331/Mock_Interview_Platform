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
  description = "Models the text agents (Planner, Evaluator, Coach) may invoke, in fallback order. An id prefixed `us.` is a cross-region inference profile and is granted differently — see locals in main.tf. Each entry verified invocable in us-east-1 on 2026-08-26."
  default = [
    "mistral.ministral-3-8b-instruct",
    # Not `meta.llama4-scout-17b-instruct-v1:0`. The bare foundation-model id
    # rejects on-demand invocation outright; only the profile form works.
    "us.meta.llama4-scout-17b-instruct-v1:0",
    "qwen.qwen3-coder-30b-a3b-v1:0",
  ]
}

variable "inference_profile_regions" {
  type        = list(string)
  description = "Regions a `us.` cross-region inference profile may route a request into. The invoke is authorised against the foundation model in the destination region, so every member region needs granting or the fallback fails with an AccessDenied naming a region this config never sets."
  default     = ["us-east-1", "us-east-2", "us-west-2"]
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

variable "sessions_table_arn" {
  type        = string
  description = "ARN of the interview sessions table, from the dynamodb module. Wired through the module output rather than reconstructed from the name, so a rename cannot leave this policy pointing at a table that no longer exists."
}

variable "bedrock_speech_model_id" {
  type        = string
  description = "Speech-to-speech model for the live interview loop. Confirm region availability before changing aws_region — unlike the text models this one has no fallback, and a mismatch fails at runtime rather than at apply."
  default     = "amazon.nova-2-sonic-v1:0"
}
