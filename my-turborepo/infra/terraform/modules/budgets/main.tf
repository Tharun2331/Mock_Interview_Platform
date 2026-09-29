# AWS Budgets for the account.
#
# Two budgets, because the two failure modes differ:
#
#   bedrock  Model spend: the text agents and the Nova 2 Sonic voice stream.
#            The cost that scales with users and with abuse.
#   total    Everything. Catches always-on infrastructure left running.
#
# Each alerts twice: when ACTUAL spend passes 80% of the limit, and when the
# month's FORECAST passes 100%. The forecast alert is the early one, since it
# fires days before the money is actually spent.
#
# Budgets notify; they do not stop anything. The hard stops are in the
# application (the interview quota and the daily model budget in
# apps/servers/lib/budget.ts). These are the net under those.
#
# Cost: the first two budgets in an account are free.

locals {
  notifications = length(var.alert_emails) == 0 ? [] : [
    { type = "ACTUAL", threshold = 80 },
    { type = "FORECASTED", threshold = 100 },
  ]
}

resource "aws_budgets_budget" "bedrock" {
  name         = "prepilot-bedrock-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.bedrock_monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # The Cost Explorer service name. Nova 2 Sonic bills under it too.
  cost_filter {
    name   = "Service"
    values = ["Amazon Bedrock"]
  }

  dynamic "notification" {
    for_each = local.notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = var.alert_emails
    }
  }

  tags = var.tags
}

resource "aws_budgets_budget" "total" {
  name         = "prepilot-account-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.total_monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = local.notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = var.alert_emails
    }
  }

  tags = var.tags
}
