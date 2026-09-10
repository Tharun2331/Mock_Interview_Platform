output "eval_queue_url" {
  description = "Queue URL for the API service's EVAL_QUEUE_URL and the worker's poller."
  value       = aws_sqs_queue.eval.id
}

output "eval_queue_arn" {
  description = "Queue ARN, for scoping sqs:SendMessage on the API role and sqs:ReceiveMessage / sqs:DeleteMessage on the worker role to this queue alone."
  value       = aws_sqs_queue.eval.arn
}

output "eval_queue_name" {
  description = "Queue name, for CloudWatch alarm dimensions once the cloudwatch module exists."
  value       = aws_sqs_queue.eval.name
}

output "eval_dlq_arn" {
  description = "Dead-letter queue ARN. Nothing writes to it directly — it is a redrive target — but an alarm on its depth is the signal that answers are going unscored."
  value       = aws_sqs_queue.eval_dlq.arn
}

output "eval_dlq_name" {
  description = "Dead-letter queue name, for the ApproximateNumberOfMessagesVisible alarm dimension."
  value       = aws_sqs_queue.eval_dlq.name
}
