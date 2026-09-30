# The pre sign-up trigger: the free substitute for Cognito's paid threat
# protection against free-interview farming. The reasoning is in
# pre_sign_up/index.mjs.
#
# Cost: Lambda's free tier is 1M requests and 400,000 GB-seconds a month, and
# this runs once per sign-up attempt at 128 MB for a few milliseconds. The log
# group keeps 14 days, well inside CloudWatch Logs' free 5 GB.

locals {
  pre_sign_up_name = "prepilot-pre-sign-up-${var.environment}"
}

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

# Logs to its own group and nothing else. It needs no AWS API: the decision is
# made from the event alone.
data "aws_iam_policy_document" "pre_sign_up_logs" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.pre_sign_up.arn}:*"]
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
  memory_size      = 128
  # Cognito waits at most 5 seconds for a trigger. This does no I/O, so it
  # finishes in milliseconds; the timeout is just below Cognito's.
  timeout = 3

  environment {
    variables = {
      BLOCK_PLUS_ADDRESSING = tostring(var.block_plus_addressing)
      BLOCKED_EMAIL_DOMAINS = join(",", var.extra_blocked_email_domains)
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
