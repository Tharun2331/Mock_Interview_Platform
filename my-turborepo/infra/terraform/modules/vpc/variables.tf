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

variable "enable_nat_instance" {
  type        = bool
  description = "Create the NAT instance and the private subnets' default route through it. Off until an app server runs in the private subnets (~$7/mo when on)."
  default     = false
}

variable "nat_instance_type" {
  type        = string
  description = "Instance type for the NAT instance. Must be Graviton (arm64): the AMI is the arm64 AL2023 image."
  default     = "t4g.nano"
}
