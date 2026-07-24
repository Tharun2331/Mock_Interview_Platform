variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
  default     = "dev"
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC"
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  type        = list(string)
  description = "AZs to spread subnets across (must be in the provider's US region)"
  default     = ["us-east-1a", "us-east-1b"]
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for the public subnets (one per AZ)"
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for the private subnets (one per AZ)"
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "enable_nat_gateway" {
  type        = bool
  description = "Create a NAT gateway + EIP for private-subnet egress. Off during local dev to avoid ~$32/mo; turn on when deploying ECS."
  default     = false
}

variable "container_port" {
  type        = number
  description = "Port the ECS service listens on (ALB forwards to this)"
  default     = 3000
}

variable "redis_port" {
  type        = number
  description = "Port ElastiCache Redis listens on"
  default     = 6379
}
