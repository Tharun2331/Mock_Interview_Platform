data "aws_caller_identity" "current" {}

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Frontend static-asset bucket (served via CloudFront, section 5 of CLAUDE.md).
# Account ID suffix guarantees the globally-unique bucket name.
resource "aws_s3_bucket" "frontend" {
  bucket = "preppilot-frontend-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = local.common_tags
}

# Private bucket — CloudFront reaches it via Origin Access Control, never public.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Placeholder landing page — swap once apps/web has a real build.
resource "aws_s3_object" "placeholder_index" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "index.html"
  content      = "<h1>PrepPilot AI — coming soon</h1>"
  content_type = "text/html"
}

# ---------------------------------------------------------------------------
# Candidate uploads: resumes/<uid>/<sid>.pdf and audio/<sid>/<qId>
#
# Separate from the frontend bucket on purpose. The frontend bucket is a public
# CDN origin; this one holds personal data and must never be reachable from the
# internet. One bucket serving both roles is one policy mistake away from
# publishing resumes.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "uploads" {
  bucket = "preppilot-uploads-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Resumes are personal data. SSE-S3 is the floor; there is no reason to store
# them unencrypted, and enabling it later does not encrypt existing objects.
resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Interview audio is raw PCM — roughly ten times the size of a compressed
# format — and the DynamoDB transcripts carry everything the Evaluator and Coach
# actually read. Without this rule storage grows monotonically for objects
# nothing consumes.
#
# Resumes are deliberately NOT expired here: they are the Planner's input and a
# candidate may re-run a session against the same upload.
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-interview-audio"
    status = "Enabled"

    filter {
      prefix = "audio/"
    }

    expiration {
      days = var.audio_retention_days
    }
  }

  # Reclaims storage from interrupted uploads, which are otherwise invisible
  # and billed indefinitely.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
