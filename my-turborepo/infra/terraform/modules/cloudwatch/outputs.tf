output "api_log_group_name" {
  description = "Log group the API service must write to. The `ecs` module's task definition points its awslogs driver here — until it does, no EMF is ingested and every custom-metric alarm in this module stays in INSUFFICIENT_DATA."
  value       = aws_cloudwatch_log_group.api.name
}

output "api_log_group_arn" {
  description = "ARN of the API log group. Consumed by the iam module to scope the task role's logs:PutLogEvents to this group and no other."
  value       = aws_cloudwatch_log_group.api.arn
}

output "worker_log_group_name" {
  description = "Log group the Evaluator worker's task definition must write to. Separate from the API's so the worker role cannot write into the stream the API's metric alarms are extracted from."
  value       = aws_cloudwatch_log_group.worker.name
}

output "worker_log_group_arn" {
  description = "ARN of the worker log group, for scoping the worker role's logs:PutLogEvents."
  value       = aws_cloudwatch_log_group.worker.arn
}

output "alarm_names" {
  description = "Every alarm this module creates, for a smoke check after apply: `aws cloudwatch describe-alarms --alarm-names $(terraform output -json alarm_names | jq -r 'join(\" \")')`. Expect the DLQ alarm in OK or ALARM and the rest in INSUFFICIENT_DATA until ECS ships logs."
  value = [
    aws_cloudwatch_metric_alarm.api_5xx.alarm_name,
    aws_cloudwatch_metric_alarm.api_latency.alarm_name,
    aws_cloudwatch_metric_alarm.sonic_errors.alarm_name,
    aws_cloudwatch_metric_alarm.sonic_billed_time.alarm_name,
    aws_cloudwatch_metric_alarm.eval_dlq_depth.alarm_name,
  ]
}
