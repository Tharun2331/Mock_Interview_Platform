variable "environment" {
  type=string
  description= "Deployment environment (dev | prod)"
}

variable "aws_region" {
  type=string
  description="AWS region where Bedrock models are accessed"
}


variable "bedrock_model_ids" {
  type = list(string)
  default = [
    "mistral.ministral-3-8b-instruct",
    "meta.llama4-scout-17b-instruct-v1:0",
    "qwen.qwen3-coder-30b-a3b-v1:0",
  ]
}

