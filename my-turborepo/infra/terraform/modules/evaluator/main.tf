data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  function_name = "prepilot-evaluator-${var.environment}"
}

# ---------------------------------------------------------------------------
# The Evaluator worker as a container-image Lambda (ADR-0009), consuming the
# eval queue through an event-source mapping.
#
# Code ships separately from infrastructure, the same split as the API server:
# Terraform owns the repository and the function, and
# apps/servers/scripts/deploy-evaluator.ts builds, pushes and points the
# function at a new image. `image_uri` is ignored after creation so an apply
# never rolls a deployed image back.
#
# First rollout, once: the function cannot be created before an image exists
# in its repository, so the repository goes first —
#   terraform apply -target=module.evaluator.aws_ecr_repository.evaluator
#   bun run deploy:evaluator            (apps/servers — pushes the first image)
#   terraform apply                     (creates the function and its trigger)
#
# No VPC attachment, by design: Bedrock, DynamoDB and SQS are reachable over
# AWS's network, so the worker shares no failure domain with the NAT instance.
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "evaluator" {
  name                 = local.function_name
  image_tag_mutability = "MUTABLE"
  # Every image is rebuildable from git, so deleting the repository is never
  # blocked by what is in it.
  force_delete = true

  # Basic scanning is free and runs on every push.
  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.common_tags
}

# Storage is billed per GB-month, and every deploy adds an image. Keep enough
# history to roll back, drop the untagged layers a re-tag leaves behind.
resource "aws_ecr_lifecycle_policy" "evaluator" {
  repository = aws_ecr_repository.evaluator.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged images are leftovers from a re-tag"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 10 deploys for rollback"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      },
    ]
  })
}

# Lambda pulls the image as its own service principal. Declared here rather
# than left to Lambda's habit of editing the repository policy itself on
# function creation, which would be drift Terraform reverts on the next apply.
# Scoped to this function by source ARN.
data "aws_iam_policy_document" "ecr_lambda_pull" {
  statement {
    sid    = "LambdaPull"
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "aws:sourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.function_name}",
      ]
    }
  }
}

resource "aws_ecr_repository_policy" "evaluator" {
  repository = aws_ecr_repository.evaluator.name
  policy     = data.aws_iam_policy_document.ecr_lambda_pull.json
}

resource "aws_lambda_function" "evaluator" {
  function_name = local.function_name
  description   = "Scores interview answers from the eval queue (${var.environment})"
  role          = var.role_arn

  package_type = "Image"
  image_uri    = "${aws_ecr_repository.evaluator.repository_url}:${var.initial_image_tag}"
  # Graviton: ~20% cheaper per GB-second, and the image is built for it.
  architectures = ["arm64"]

  memory_size = var.memory_mb
  timeout     = var.timeout_seconds

  environment {
    variables = var.environment_variables
  }

  # Into the worker log group the cloudwatch module already owns — and that the
  # worker role is already scoped to write — rather than Lambda's default
  # /aws/lambda/<name>, which the role cannot write and no alarm reads.
  logging_config {
    log_format = "Text"
    log_group  = var.log_group_name
  }

  tags = local.common_tags

  lifecycle {
    # Deploys move this (deploy-evaluator.ts); Terraform only sets it once.
    ignore_changes = [image_uri]
  }

  depends_on = [aws_ecr_repository_policy.evaluator]
}

resource "aws_lambda_event_source_mapping" "eval_queue" {
  event_source_arn = var.eval_queue_arn
  function_name    = aws_lambda_function.evaluator.arn

  # One answer per invocation. The handler reports failures per message
  # anyway; a batch of one keeps a slow generation from holding others back
  # and makes timeout_seconds a per-answer budget.
  batch_size = 1

  # Without this, one failed answer would make SQS redeliver the whole batch.
  function_response_types = ["ReportBatchItemFailures"]

  # The spend ceiling. Each concurrent invocation is a Bedrock generation in
  # flight; 2 is the lowest value SQS allows and clears an interview's answers
  # in well under a minute.
  scaling_config {
    maximum_concurrency = var.max_concurrency
  }
}
