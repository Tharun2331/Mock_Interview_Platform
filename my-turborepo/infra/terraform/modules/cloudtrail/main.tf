# An account-wide audit trail: every management API call (IAM changes, bucket
# policy edits, Cognito admin actions, key creation) written to S3 as signed log
# files that outlive CloudTrail's 90-day console history.
#
# Kept inside the free tier on purpose:
#   - ONE trail, management events only. The first copy of management events
#     is free; data events (S3 object reads, Lambda invokes) are billed per event
#     and are not enabled.
#   - No CloudWatch Logs delivery, no Insights, no Lake. All billed.
#   - Log files expire after var.retention_days, so the S3 storage stays within
#     the free allowance.
#
# Multi-region: an attacker's first move is often a region nobody watches.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  trail_name = "prepilot-audit"
  trail_arn  = "arn:${data.aws_partition.current.partition}:cloudtrail:${data.aws_region.current.region}:${local.account_id}:trail/${local.trail_name}"
}

resource "aws_s3_bucket" "trail" {
  bucket = "prepilot-cloudtrail-${local.account_id}"

  tags = var.tags
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket = aws_s3_bucket.trail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    id     = "expire-audit-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.retention_days
    }
  }
}

# The standard CloudTrail delivery policy, scoped to this account's trail by
# SourceArn so no other trail can write here, plus a TLS-only deny.
data "aws_iam_policy_document" "trail" {
  statement {
    sid       = "CloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.trail.arn,
      "${aws_s3_bucket.trail.arn}/*",
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

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail.json

  depends_on = [aws_s3_bucket_public_access_block.trail]
}

resource "aws_cloudtrail" "audit" {
  name           = local.trail_name
  s3_bucket_name = aws_s3_bucket.trail.id

  is_multi_region_trail         = true
  include_global_service_events = true
  # Each hour's files get a signed digest, so tampering with a log file after
  # the fact is detectable with `aws cloudtrail validate-logs`. Free.
  enable_log_file_validation = true

  # Management events only, reads and writes. No data_resource blocks: those
  # are the billed part of CloudTrail.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  tags = var.tags

  # The trail validates its bucket policy on creation.
  depends_on = [aws_s3_bucket_policy.trail]
}
