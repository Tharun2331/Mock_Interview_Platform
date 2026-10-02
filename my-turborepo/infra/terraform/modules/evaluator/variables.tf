variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "role_arn" {
  type        = string
  description = "Execution role (iam module's evaluator worker role). Never the API server's: this one cannot open a Sonic stream."
}

variable "eval_queue_arn" {
  type        = string
  description = "The eval queue the function consumes"
}

variable "log_group_name" {
  type        = string
  description = "Worker log group (cloudwatch module) the function writes to instead of Lambda's default group"
}

variable "environment_variables" {
  type        = map(string)
  description = "The worker's environment. Not for secrets: Lambda environment variables are readable by anyone who can read the function."
}

variable "timeout_seconds" {
  type        = number
  description = "Per-invocation budget, and with batch_size 1, per answer. The eval queue's visibility timeout must be at least this; AWS recommends 6x."
  default     = 150
}

variable "memory_mb" {
  type        = number
  description = "Memory, which also sets the CPU share. The work is waiting on Bedrock, not computing."
  default     = 512
}

variable "max_concurrency" {
  type        = number
  description = "Most invocations the queue may run at once: the cap on Bedrock generations in flight. 2 is SQS's minimum."
  default     = 2
}

variable "initial_image_tag" {
  type        = string
  description = "Tag the function is created with. Only read at creation; deploys move the image afterwards."
  default     = "latest"
}
