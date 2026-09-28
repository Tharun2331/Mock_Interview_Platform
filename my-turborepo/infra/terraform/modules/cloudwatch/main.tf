locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # Every alarm watches the SAME dimension set: the Environment-only aggregate.
  #
  # Not the per-route series, deliberately. A per-route alarm needs one alarm per
  # route, which means an alarm has to be added every time a route is, and the
  # route that gets forgotten is the one that breaks. The aggregate catches a
  # service-wide problem, which is what waking somebody up is for; deciding WHICH
  # route is slow is a dashboard question, and GET /admin/metrics answers it with
  # the per-route breakdown.
  metric_dimensions = {
    (var.metric_dimension_name) = var.metric_dimension_value
  }
}

# ---------------------------------------------------------------------------
# Log group
#
# This is the load-bearing resource in the module, not the alarms.
#
# The API publishes custom metrics as CloudWatch Embedded Metric Format — JSON
# lines on stdout — and CloudWatch Logs extracts them into metrics AT INGESTION.
# So this log group is not just where logs go: it is the only path by which any of
# the metrics below come into existence. No log group, no metrics, and every alarm
# here sits in INSUFFICIENT_DATA while looking correctly configured.
#
# **No metric filters, and that is not an omission.** EMF extraction is automatic
# for any log event carrying an `_aws` block; a metric filter would be a second,
# hand-maintained parser of the same lines. That is the usual mistake here —
# writing filter patterns for data CloudWatch already understands, then keeping
# them in sync with the emitter by hand.
#
# Created here rather than by the `ecs` module so the metric pipeline is owned by
# the module that reads it. The consequence to know: until an `ecs` module exists
# and points a task's awslogs driver at this group, nothing writes to it. The
# emitter is correct and the alarms are correct and neither has any data — see the
# note in apps/servers/lib/metrics.ts.
resource "aws_cloudwatch_log_group" "api" {
  name = "/prepilot/${var.environment}/api"

  # Explicit, because CloudWatch's default is "never expire" — ingestion bills
  # once and storage bills every month forever, so the default is the expensive
  # one and it is the one you get by writing nothing.
  retention_in_days = var.log_retention_days

  # No `kms_key_id`, on the same reasoning the dynamodb module gives for omitting
  # server-side encryption: the default is AWS-managed encryption at rest, which is
  # free. A customer-managed key bills per API call and puts a KMS availability
  # dependency in the path of every log line — including the metric lines the
  # alarms depend on.

  tags = local.common_tags
}

# The Evaluator worker's logs, in their own group.
#
# Separate from the API's rather than a second stream in it, so the worker role can
# be granted writes here and denied them there. That matters more than it looks:
# custom metrics are extracted from log content, so a role that can write into the
# API's group can forge the API's metrics — including the series the alarms above
# fire on. Splitting the groups is the logging half of the "two task roles, never
# shared" rule in infra/terraform/CLAUDE.md.
#
# No alarms on it yet. The worker's failure signal is the DLQ depth alarm below,
# which is a better one: it measures the outcome (feedback that will never arrive)
# rather than a proxy for it.
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/prepilot/${var.environment}/worker"
  retention_in_days = var.log_retention_days

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Alarms
#
# `treat_missing_data` is set explicitly on every one of these, and the value
# differs by alarm on purpose. It is the single most consequential field here and
# its default ("missing") is wrong for most of them:
#
#   - notBreaching — for alarms on metrics that are ABSENT when healthy. Requests
#     4xx/5xx and Sonic errors are only emitted when the service is running, so a
#     quiet night has no datapoints and "missing" would leave the alarm stuck in
#     INSUFFICIENT_DATA rather than OK. The API writes explicit zeroes for the
#     request-error counts, so in practice those do have data whenever anything is
#     serving — but "absent means fine" is still the honest reading when nothing is.
#   - missing — for the DLQ, where absence genuinely tells you nothing: SQS
#     publishes ApproximateNumberOfMessagesVisible on a schedule, so a gap means
#     CloudWatch lost sight of the queue, not that the queue is empty.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name        = "prepilot-api-5xx-${var.environment}"
  alarm_description = "The API returned ${var.error_rate_threshold} or more 5xx responses in five minutes. Something is broken server-side; candidates are seeing failures."

  namespace   = var.metrics_namespace
  metric_name = "Requests5xx"
  dimensions  = local.metric_dimensions

  # Sum, not Average. An average count per datapoint is a number with no
  # interpretation — the question is "how many failures", which is a total.
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.error_rate_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # One period, not several. A burst of server errors is worth knowing about
  # immediately, and requiring two consecutive periods would delay the signal by
  # five minutes to filter noise that a 5xx count does not have — unlike latency,
  # which genuinely spikes on a cold start and is given two periods below.
  treat_missing_data = "notBreaching"
  alarm_actions      = var.alarm_actions
  ok_actions         = var.alarm_actions

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name        = "prepilot-api-latency-${var.environment}"
  alarm_description = "p95 request latency exceeded ${var.latency_p95_threshold_ms}ms across two consecutive five-minute periods."

  namespace   = var.metrics_namespace
  metric_name = "RequestLatency"
  dimensions  = local.metric_dimensions

  # `extended_statistic`, not `statistic`. The two are mutually exclusive in this
  # resource, and a percentile must use the extended field — putting "p95" in
  # `statistic` is an apply-time error rather than a silent fallback, which is the
  # one merciful thing about this API.
  extended_statistic = "p95"

  period = 300
  # Two periods, unlike the 5xx alarm. A single slow five minutes is a cold start,
  # a deploy, or one unlucky Bedrock call; ten sustained minutes is a problem. This
  # is the alarm most likely to be silenced if it cries wolf, and a silenced alarm
  # reads as coverage while providing none.
  evaluation_periods  = 2
  threshold           = var.latency_p95_threshold_ms
  comparison_operator = "GreaterThanThreshold"

  treat_missing_data = "notBreaching"
  alarm_actions      = var.alarm_actions
  ok_actions         = var.alarm_actions

  tags = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "sonic_errors" {
  alarm_name        = "prepilot-sonic-errors-${var.environment}"
  alarm_description = "${var.sonic_error_threshold} or more Nova 2 Sonic stream errors in five minutes. There is no fallback speech model, so each of these is an interview that failed mid-conversation."

  namespace   = var.metrics_namespace
  metric_name = "SonicStreamErrors"
  dimensions  = local.metric_dimensions

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.sonic_error_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"

  treat_missing_data = "notBreaching"
  alarm_actions      = var.alarm_actions
  ok_actions         = var.alarm_actions

  tags = local.common_tags
}

# The cost alarm, and the one infra/terraform/CLAUDE.md specifically asks for.
#
# Nova 2 Sonic bills for as long as a bidirectional stream stays open, whether or
# not anyone is speaking. No Terraform resource can cap that — it is an
# application concern — so this alarm is the closest thing to a safety net, and
# without it a leaked stream is invisible until the bill arrives.
#
# Watches a metric MATH expression rather than the raw metric, because the raw
# series is milliseconds and a threshold in milliseconds is unreadable: 7200000 is
# not a number anyone can sanity-check in a review. The expression converts to
# minutes so the threshold says what it means.
resource "aws_cloudwatch_metric_alarm" "sonic_billed_time" {
  alarm_name        = "prepilot-sonic-billed-time-${var.environment}"
  alarm_description = "Nova 2 Sonic streams were open for more than ${var.sonic_billed_minutes_threshold} minutes in total over one hour. Sonic bills by open duration, so this is either real usage or a leaked stream — check SonicStreamRenewals and the interview count before raising the threshold."

  # An hour, not five minutes. A leaked stream is a slow burn rather than a spike:
  # one stream left open costs the same per minute as a busy interview, so it only
  # separates from real traffic over a longer window.
  evaluation_periods  = 1
  threshold           = var.sonic_billed_minutes_threshold
  comparison_operator = "GreaterThanThreshold"

  # Missing data is NOT treated as breaching here even though this is the cost
  # alarm. A gap means nothing was ingested, which is the current state of the
  # world — no ECS, no logs — and "breaching" would leave this alarm permanently
  # red and therefore permanently ignored.
  treat_missing_data = "notBreaching"
  alarm_actions      = var.alarm_actions
  ok_actions         = var.alarm_actions

  metric_query {
    id          = "billed_minutes"
    expression  = "totalMs / 60000"
    label       = "Sonic billed minutes per hour"
    return_data = true
  }

  metric_query {
    id = "totalMs"

    metric {
      namespace   = var.metrics_namespace
      metric_name = "SonicStreamDuration"
      dimensions  = local.metric_dimensions
      period      = 3600
      stat        = "Sum"
    }
  }

  tags = local.common_tags
}

# The one alarm on an AWS-published metric rather than a custom one.
#
# It therefore needs no log group and no EMF, which means it is the only alarm in
# this module that WORKS TODAY — the queue and the worker have been live in dev
# since Phase 5. Worth knowing when the others look broken: this one is the
# control.
resource "aws_cloudwatch_metric_alarm" "eval_dlq_depth" {
  alarm_name        = "prepilot-eval-dlq-${var.environment}"
  alarm_description = "A message reached the evaluation dead-letter queue. It has already failed maxReceiveCount times, so this is a candidate's feedback that will never arrive without intervention."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = var.eval_dlq_name
  }

  # Maximum, not Sum. The metric is a GAUGE — the depth at each sample — so
  # summing it adds the same messages together once per sample and reports a depth
  # that never existed. This is the single most common error in an SQS alarm.
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.dlq_depth_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # `missing`, unlike every alarm above. Absence here genuinely means "CloudWatch
  # cannot see the queue" rather than "the queue is empty": SQS publishes this
  # metric on its own schedule regardless of traffic, so a gap is a monitoring
  # failure and should not read as OK.
  treat_missing_data = "missing"
  alarm_actions      = var.alarm_actions
  ok_actions         = var.alarm_actions

  tags = local.common_tags
}
