output "alarm_actions" {
  description = "Pass to the cloudwatch module's alarm_actions. Empty when no emails are configured, so alarms never point at a topic nobody reads."
  value       = [for topic in aws_sns_topic.alarms : topic.arn]
}
