data "aws_caller_identity" "current" {}


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

# 1. Create the Access Key and Secret Key for the user
resource "aws_iam_access_key" "terraform_keys" {
  user = aws_iam_user.terraform.name
}

# 2. Output the Access Key ID
output "aws_access_key_id" {
  value       = aws_iam_access_key.terraform_keys.id
  description = "The IAM Access Key ID"
}

# 3. Output the Secret Access Key (Marked as sensitive so it isn't leaked in logs)
output "aws_secret_access_key" {
  value       = aws_iam_access_key.terraform_keys.secret
  description = "The IAM Secret Access Key"
  sensitive   = true
}