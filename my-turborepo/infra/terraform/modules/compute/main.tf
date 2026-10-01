data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Every parameter under this path becomes one environment variable, named
  # after the last path segment. Trailing slash matters to the loader.
  ssm_env_path = "/prepilot/${var.environment}/api/env/"

  # The server's own port is part of its environment, and also what step 3's
  # CloudFront VPC origin and security-group rule target, so it is set here
  # rather than trusted to the caller's map.
  service_environment = merge(var.environment_variables, {
    PORT = tostring(var.app_port)
  })

  artifact_key = "api/server"
}

# The API server (ADR-0008). One instance in a private subnet, no public IP,
# reached only by CloudFront's VPC origin. No auto-scaling and no self-healing,
# accepted for v1.
#
# Same AL2023 arm64 image as the NAT instance. `ami` is ignored after creation
# so a new AL2023 release does not replace a running server.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile   = aws_iam_instance_profile.api.name

  credit_specification {
    cpu_credits = var.cpu_credits
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_type = "gp3"
    encrypted   = true
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region           = local.region
    ssm_env_path     = local.ssm_env_path
    artifacts_bucket = aws_s3_bucket.artifacts.id
    artifact_key     = local.artifact_key
    log_group_name   = var.log_group_name
  })

  tags = merge(local.common_tags, { Name = "prepilot-api-${var.environment}" })

  lifecycle {
    ignore_changes = [ami]
  }

  # The service reads these on its first start.
  depends_on = [aws_ssm_parameter.env]
}

# No ingress yet: the only thing allowed to reach this instance is CloudFront's
# VPC origin, whose service-managed security group exists only once that origin
# does. The rule admitting it lands with the CloudFront wiring. Management is
# Session Manager, which needs no inbound port.
#
# Egress is HTTPS only. That covers the NAT instance path (Bedrock, SQS,
# Cognito, SSM, CloudWatch Logs, GitHub) and the S3/DynamoDB gateway endpoints.
resource "aws_security_group" "api" {
  name        = "prepilot-api-${var.environment}"
  description = "API server: ingress from CloudFront VPC origin only, HTTPS out"
  vpc_id      = var.vpc_id

  egress {
    description = "HTTPS to AWS APIs and api.github.com"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "prepilot-api-${var.environment}" })
}

# ---------------------------------------------------------------------------
# IAM
#
# The application's permissions stay on the server role in the iam module.
# What is added here is what the HOST needs and the app does not: Session
# Manager, reading its own config, pulling its build, and the agent's log
# stream lookup.
# ---------------------------------------------------------------------------
resource "aws_iam_instance_profile" "api" {
  name = "prepilot-api-${var.environment}"
  role = var.server_role_name

  tags = local.common_tags
}

# AWS's baseline for Session Manager. Several of its actions (ssmmessages:*,
# ec2messages:*) have no resource-level permissions.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = var.server_role_name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  # The service's environment. Read-only and limited to its own path, so it
  # cannot read the Google client secret under /prepilot/<env>/google.
  #
  # IAM authorises GetParametersByPath against the path exactly as the caller
  # passed it, so the trailing-slash form the loader uses must be listed; the
  # bare form covers anyone calling it without the slash.
  statement {
    sid     = "ReadServiceEnvironment"
    effect  = "Allow"
    actions = ["ssm:GetParametersByPath"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_env_path}",
      "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(local.ssm_env_path, "/")}",
    ]
  }

  statement {
    sid       = "PullBuild"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/${local.artifact_key}"]
  }

  # The CloudWatch agent looks up its stream before writing. Create and Put
  # are already on the server role, scoped to this same group.
  statement {
    sid       = "AgentDescribeStreams"
    effect    = "Allow"
    actions   = ["logs:DescribeLogStreams"]
    resources = [var.log_group_arn, "${var.log_group_arn}:*"]
  }
}

resource "aws_iam_policy" "host" {
  name        = "prepilot-api-host-${var.environment}"
  description = "Host-level access for the PrepPilot API instance: its config, its build, and log stream lookup (${var.environment})"
  policy      = data.aws_iam_policy_document.host.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "host" {
  role       = var.server_role_name
  policy_arn = aws_iam_policy.host.arn
}

# ---------------------------------------------------------------------------
# Service environment
#
# Plain String parameters: nothing here is a secret (table and bucket names,
# a queue URL, Cognito's public ids). A secret added later should be a
# SecureString written out of band, per infra/terraform/CLAUDE.md.
# ---------------------------------------------------------------------------
resource "aws_ssm_parameter" "env" {
  for_each = local.service_environment

  name  = "${local.ssm_env_path}${each.key}"
  type  = "String"
  value = each.value

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Build artifacts
#
# One object, `api/server`, the compiled server. Versioned so a bad deploy
# can be rolled back by restoring the previous version and re-running deploy.
# force_destroy because everything in it is rebuildable from git.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "artifacts" {
  bucket        = "prepilot-artifacts-${var.environment}-${local.account_id}"
  force_destroy = true

  tags = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-old-builds"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}
