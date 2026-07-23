data "aws_caller_identity" "current" {}

# Frontend static-asset bucket (served via CloudFront, section 5 of CLAUDE.md).
# Account ID suffix guarantees the globally-unique bucket name.
resource "aws_s3_bucket" "frontend" {
  bucket = "preppilot-frontend-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Project     = "prepilot"
    Environment = var.environment
  }
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
