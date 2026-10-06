terraform {
  required_version = "~> 1.15.4"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.54.0"
    }
  }

  # Same bucket as dev, its own key. Applied from `master` only — see
  # infra/terraform/CLAUDE.md, "Branches and state".
  backend "s3" {
    bucket       = "prepilot-tfstate-554448409975"
    key          = "environments/prod/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    profile      = "prepilot-terraform"
  }
}
