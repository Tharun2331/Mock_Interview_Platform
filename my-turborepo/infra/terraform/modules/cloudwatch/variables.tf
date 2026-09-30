variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "metrics_namespace" {
  type        = string
  description = "CloudWatch namespace the API service publishes custom metrics to. MUST match `metricsNamespace` in apps/servers/lib/config.ts and what routes/adminMetrics.ts queries. A mismatch does not fail: the alarms sit in INSUFFICIENT_DATA forever and the dashboard shows empty series, which both look identical to an idle service."
  default     = "PrepPilot/API"
}

variable "metric_dimension_name" {
  type        = string
  description = "Dimension every metric carries. Matches METRICS.DIMENSION_ENVIRONMENT in apps/servers/lib/constants.ts. Alarms watch the Environment-only aggregate, never the per-route series — a per-route alarm would need one alarm per route and would miss a new route entirely."
  default     = "Environment"
}

variable "metric_dimension_value" {
  type        = string
  description = "Value of the environment dimension, i.e. what the service sets APP_ENV to. Deliberately separate from `environment` so the two can be set independently: the tag says where the alarm lives, this says whose metrics it reads, and conflating them is how a dev alarm ends up watching prod's series."
}

variable "log_retention_days" {
  type        = number
  description = "How long API logs are kept. This is the cost lever on logging: ingestion is billed once but storage is billed monthly forever at `never expire`, which is CloudWatch's default and the reason this has no null option. 30 days covers any incident worth investigating from a log."
  default     = 30
}

# ---------------------------------------------------------------------------
# Alarm thresholds
#
# Every one of these is a judgement call rather than a derived number, and each is
# set where a human should actually be told rather than where something is
# technically abnormal. An alarm that fires on ordinary variation is an alarm
# somebody silences, and a silenced alarm is worse than no alarm — it reads as
# coverage.
# ---------------------------------------------------------------------------

variable "error_rate_threshold" {
  type        = number
  description = "5xx responses in a 5-minute period before alarming. Counted absolutely rather than as a ratio: at this traffic level a ratio is dominated by its denominator, so three errors out of four requests would alarm on a quiet morning while thirty out of ten thousand would not."
  default     = 5
}

variable "latency_p95_threshold_ms" {
  type        = number
  description = "p95 request latency in milliseconds before alarming. p95, not average — a route where one request in twenty takes nine seconds has a healthy mean and an unhappy user. Set above the Planner's own budget (BEDROCK.REQUEST_TIMEOUT_MS is 30s for a single attempt) would never fire; set at typical latency it fires on every cold start. 3000 is 'slower than a Bedrock call should be, faster than the timeout'."
  default     = 3000
}

variable "sonic_error_threshold" {
  type        = number
  description = "Sonic stream errors in a 5-minute period before alarming. Low on purpose: there is no fallback speech model, so every one of these is an interview that broke for a candidate mid-sentence. Two in five minutes is a pattern, not noise."
  default     = 2
}

variable "sonic_billed_minutes_threshold" {
  type        = number
  description = "Total Sonic open-stream MINUTES in one hour before alarming. This is the leaked-stream detector and the closest thing infrastructure can offer to a spend cap — Sonic bills by open duration whether or not anyone is speaking, and no .tf file can cap it. Default assumes a handful of concurrent interviews; raise it deliberately when real usage exceeds it rather than after being paged."
  default     = 120
}

variable "dlq_depth_threshold" {
  type        = number
  description = "Messages in the evaluation dead-letter queue before alarming. 1, because a message reaching the DLQ has already failed maxReceiveCount times — there is no such thing as an acceptable steady-state depth here, and anything above zero is feedback a candidate earned and will not receive."
  default     = 1
}

variable "eval_dlq_name" {
  type        = string
  description = "Name (not ARN) of the evaluation dead-letter queue, from the sqs module. CloudWatch's SQS dimension is QueueName, so the name is what an alarm needs; taking the ARN and parsing it would be string surgery over a value the module already outputs."
}

variable "alarm_actions" {
  type        = list(string)
  description = "SNS topic ARNs notified when an alarm fires. Deliberately empty by default and deliberately NOT a topic created by this module: a topic with no confirmed subscription is indistinguishable from no topic at all, and creating one here would make every alarm look wired up while notifying nobody. An alarm with no action still records state and still shows red in the console, which is the honest default until a real destination exists."
  default     = []
}

variable "auth_failure_threshold" {
  type        = number
  description = "401s (HTTP and WebSocket handshake) in a 5-minute period before alarming. A normal user produces at most one or two when a token expires mid-session, so twenty in five minutes is either an attack or a broken client."
  default     = 20
}

variable "admin_refusal_threshold" {
  type        = number
  description = "Admin-route refusals in a 15-minute period before alarming. The web app never sends a non-admin there, so a handful is already deliberate probing."
  default     = 5
}

