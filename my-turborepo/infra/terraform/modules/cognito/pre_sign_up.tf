# The pre sign-up trigger: the free substitute for Cognito's paid threat
# protection against free-interview farming — disposable-address checks, and
# the sign-up form's Turnstile token. The reasoning is in pre_sign_up/index.mjs.
#
# Cost: Lambda's free tier is 1M requests and 400,000 GB-seconds a month, and
# this runs once per sign-up attempt at 256 MB for well under a second.
# Turnstile and a standard SSM parameter are free. The log group keeps 14 days,
# well inside CloudWatch Logs' free 5 GB.

locals {
  pre_sign_up_name = "prepilot-pre-sign-up-${var.environment}"

  # The Turnstile secret. Terraform names it and grants the read; the VALUE is
  # written out of band (infra/terraform/CLAUDE.md, Secrets), so it never lands
  # in state:
  #   aws ssm put-parameter --name <this> --type SecureString --value <secret>
  # Derived from the environment, not a variable, so a dev trigger can never be
  # pointed at prod's secret.
  turnstile_secret_parameter = "/prepilot/${var.environment}/turnstile/secret_key"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

data "archive_file" "pre_sign_up" {
  type        = "zip"
  source_file = "${path.module}/pre_sign_up/index.mjs"
  output_path = "${path.module}/.build/pre_sign_up.zip"
}

# Created before the function so Lambda never auto-creates one with the
# never-expire default retention.
resource "aws_cloudwatch_log_group" "pre_sign_up" {
  name              = "/aws/lambda/${local.pre_sign_up_name}"
  retention_in_days = 14

  tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

data "aws_iam_policy_document" "pre_sign_up_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# Its own log group, and its one secret — nothing else.
data "aws_iam_policy_document" "pre_sign_up_logs" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.pre_sign_up.arn}:*"]
  }

  # The Turnstile secret, by its exact name. A SecureString under the AWS
  # managed aws/ssm key needs no kms:Decrypt here: that key's own policy lets
  # any principal in the account decrypt through SSM.
  statement {
    sid       = "ReadTurnstileSecret"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.turnstile_secret_parameter}"]
  }
}

resource "aws_iam_role" "pre_sign_up" {
  name               = "${local.pre_sign_up_name}-role"
  assume_role_policy = data.aws_iam_policy_document.pre_sign_up_assume.json

  tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy" "pre_sign_up_logs" {
  name   = "logs"
  role   = aws_iam_role.pre_sign_up.id
  policy = data.aws_iam_policy_document.pre_sign_up_logs.json
}

resource "aws_lambda_function" "pre_sign_up" {
  function_name = local.pre_sign_up_name
  role          = aws_iam_role.pre_sign_up.arn

  filename         = data.archive_file.pre_sign_up.output_path
  source_code_hash = data.archive_file.pre_sign_up.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  # 256 rather than 128 for the CPU share that comes with it: a cold start now
  # loads the SSM client and makes two network calls (SSM, then Cloudflare)
  # inside Cognito's 5-second window. Still free tier at one call per sign-up.
  memory_size = 256
  # Cognito waits at most 5 seconds for a trigger, so the timeout is Cognito's
  # own. siteverify has its own 2.5s budget inside it (index.mjs).
  timeout = 5

  environment {
    variables = {
      BLOCK_PLUS_ADDRESSING      = tostring(var.block_plus_addressing)
      BLOCKED_EMAIL_DOMAINS      = join(",", var.extra_blocked_email_domains)
      TURNSTILE_MODE             = var.turnstile_mode
      TURNSTILE_SECRET_PARAMETER = local.turnstile_secret_parameter
      TURNSTILE_HOSTNAMES        = join(",", var.turnstile_hostnames)
    }
  }

  tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  depends_on = [aws_cloudwatch_log_group.pre_sign_up]
}

# Only this pool may invoke it.
resource "aws_lambda_permission" "pre_sign_up" {
  statement_id  = "AllowCognitoPreSignUp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_sign_up.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.pool.arn
}
