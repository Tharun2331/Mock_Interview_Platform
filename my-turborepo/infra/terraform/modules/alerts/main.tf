# Where alarms go: one SNS topic, email subscribers.
#
# The cloudwatch module deliberately never creates a topic, because a topic with
# no confirmed subscriber makes every alarm look wired up while notifying nobody.
# This module keeps that promise: it creates NOTHING unless at least one email is
# given, and outputs an empty list so the alarms stay action-less.
#
# Email subscriptions start "pending confirmation". AWS sends a confirmation
# email to each address, and until someone clicks it the subscription delivers
# nothing. After applying, check that every address confirmed:
#
#   aws sns list-subscriptions-by-topic --topic-arn <topic_arn>
#
# Cost: SNS email is free for the first 1,000 notifications a month.

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  enabled = length(var.emails) > 0
}

resource "aws_sns_topic" "alarms" {
  count = local.enabled ? 1 : 0

  name = "prepilot-alarms-${var.environment}"

  # AWS-managed key: encrypted at rest, free, and CloudWatch can publish to it
  # without a key policy. A customer-managed key would need one.
  kms_master_key_id = "alias/aws/sns"

  tags = local.common_tags
}

# Only CloudWatch alarms in this account may publish, so the topic cannot be
# used to send look-alike alerts from anywhere else.
data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "alarms" {
  count = local.enabled ? 1 : 0

  statement {
    sid       = "AllowCloudWatchAlarms"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms[0].arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  count = local.enabled ? 1 : 0

  arn    = aws_sns_topic.alarms[0].arn
  policy = data.aws_iam_policy_document.alarms[0].json
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.emails)

  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = each.value
}
