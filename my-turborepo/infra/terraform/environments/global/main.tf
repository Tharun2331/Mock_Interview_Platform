data "aws_caller_identity" "current" {}

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = "global"
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = "prepilot-tfstate-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Project = "prepilot"
    Purpose = "terraform-state"
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ---------------------------------------------------------------------------
# State bucket hardening
#
# Every state file in this account lives here, and state is plaintext: it holds
# the Google OAuth client secret (cognito and ssm modules) and, until the
# `removed` block below is applied, held an administrator access key. Reading
# one object from this bucket was equivalent to owning the account. None of the
# three controls below were declared; they rested on AWS account defaults that
# nothing here guaranteed.
# ---------------------------------------------------------------------------

# No path to public, whatever a future policy or ACL says.
resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3, stated rather than inherited from the account default. Not KMS: a
# customer-managed key would add a key policy that has to admit whoever runs
# Terraform, and a mistake there locks every environment out of its own state.
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# TLS only. Deliberately a Deny on transport and nothing else: a policy that
# also tried to allowlist principals could lock the operator out of the state
# that describes the policy, and there would be no Terraform way back in.
data "aws_iam_policy_document" "terraform_state" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state.arn,
      "${aws_s3_bucket.terraform_state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state.json

  # Applied after the public access block, so there is never a moment where a
  # policy exists on a bucket that could still be made public.
  depends_on = [aws_s3_bucket_public_access_block.terraform_state]
}

# ---------------------------------------------------------------------------
# The Terraform operator identity
#
# Still an IAM user with AdministratorAccess, because that is what every
# backend's `profile = "prepilot-terraform"` authenticates as, and replacing it
# with IAM Identity Center (SSO) or GitHub OIDC is an account-level change a
# human has to make. That migration is the real fix; see the note below.
# ---------------------------------------------------------------------------

resource "aws_iam_user" "terraform" {
  name = "prepilot-terraform"

  tags = {
    Project = "prepilot"
    Purpose = "terraform-automation"
  }
}

resource "aws_iam_user_policy_attachment" "terraform_admin" {
  user       = aws_iam_user.terraform.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# The user and its AdministratorAccess attachment already existed in AWS, but
# not in this root's state: the first apply of this block failed with
# EntityAlreadyExists. They were created outside Terraform, or by an apply whose
# state was not kept. These import blocks adopt them as they are, with no change
# in AWS, so the next plan shows two imports and nothing else for them. Once
# applied, the blocks are inert and can be deleted.
import {
  to = aws_iam_user.terraform
  id = "prepilot-terraform"
}

import {
  to = aws_iam_user_policy_attachment.terraform_admin
  id = "prepilot-terraform/arn:aws:iam::aws:policy/AdministratorAccess"
}

# The access key is deliberately NOT managed here, and never should be.
#
# `aws_iam_access_key` writes the SECRET into state in plaintext, whatever
# `sensitive = true` says: sensitive only hides a value from the CLI, never from
# the state file. An earlier version of this file declared one. It turned out
# never to have been applied into this state (the live key was made outside
# Terraform), so no secret was ever stored here. The key is still a long-lived
# administrator credential of unknown history: rotate it with the CLI, and move
# to IAM Identity Center or GitHub OIDC, which remove it altogether.

# ---------------------------------------------------------------------------
# Spend alarms
#
# Here rather than in an environment root because spend is account-wide, per
# infra/terraform/CLAUDE.md. The application's own limits (the interview quota
# and the daily model budget) cap one account; these catch everything else: a
# bug, a leaked stream, a flood of new sign-ups each spending their allowance.
# ---------------------------------------------------------------------------

module "budgets" {
  source = "../../modules/budgets"

  bedrock_monthly_limit_usd = var.bedrock_monthly_limit_usd
  total_monthly_limit_usd   = var.total_monthly_limit_usd
  alert_emails              = var.budget_alert_emails
  tags                      = local.common_tags
}

# ---------------------------------------------------------------------------
# Audit trail
#
# Account-wide, so it lives here with the other shared resources. Management
# events only, which keeps it free; see the module.
# ---------------------------------------------------------------------------

module "cloudtrail" {
  source = "../../modules/cloudtrail"

  tags = local.common_tags
}
