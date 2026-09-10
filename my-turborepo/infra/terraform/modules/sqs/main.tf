locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# The evaluation queue. One message per answer, enqueued when an interview ends
# and consumed by the Evaluator worker on Fargate Spot.
#
# A standard queue, not FIFO, and that is a decision rather than a default.
# FIFO's deduplication is producer-side and expires after five minutes, so it
# does not prevent the duplicate that actually occurs here: a worker that
# receives a message, calls Bedrock, and dies before DeleteMessage. The
# visibility timeout expires and the message is redelivered — FIFO included.
#
# What FIFO would add is head-of-line blocking. Messages are ordered within a
# MessageGroupId, and the only natural group is the session, so all fifteen
# answers of one interview would score serially instead of in parallel, and a
# single poison message would stall every other answer in that session until it
# reached the DLQ.
#
# Idempotency is handled in the data layer instead: EVAL#<questionId> is written
# with PutItem, so a redelivery overwrites the same item rather than creating a
# second one, and completion is derived by querying that prefix rather than from
# a counter a duplicate would corrupt. See docs/architecture/data-model.md §1.
resource "aws_sqs_queue" "eval" {
  name = "prepilot-eval-${var.environment}"

  # Must comfortably exceed one Bedrock call plus the DynamoDB writes that
  # follow it. Too short and the message is redelivered while the first attempt
  # is still running, and that duplicate pays for a second generation — the one
  # failure mode that costs real money rather than time.
  #
  # MUST stay in sync with WORKER.VISIBILITY_TIMEOUT_SECONDS in
  # apps/servers/lib/constants.ts. They are the same number for the same reason,
  # and nothing enforces the agreement.
  visibility_timeout_seconds = var.visibility_timeout_seconds

  # Long polling at the queue level, as a backstop. The worker also asks for it
  # per receive; setting it here means a poller that forgets to still does not
  # bill a request every few milliseconds for an empty response.
  receive_wait_time_seconds = 20

  # Messages reference a candidate's interview. SQS-managed encryption is free
  # and needs no key policy, so there is no reason to leave it off.
  sqs_managed_sse_enabled = true

  message_retention_seconds = var.message_retention_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.eval_dlq.arn
    # Three receives, then the DLQ. The worker deliberately leaves a message
    # undeleted for anything a retry could fix — a DynamoDB outage, an
    # exhausted model chain — so this is the retry mechanism the Evaluator
    # relies on instead of walking a model fallback chain.
    maxReceiveCount = var.max_receive_count
  })

  tags = merge(local.common_tags, { Name = "prepilot-eval-${var.environment}" })
}

# Answers that could not be scored after `max_receive_count` attempts.
#
# Retained far longer than the main queue on purpose. A message here represents
# an answer a candidate gave that has no feedback attached, and the interview
# cannot be replayed to produce another one. Fourteen days is SQS's maximum and
# the difference between investigating on Monday and losing the evidence.
resource "aws_sqs_queue" "eval_dlq" {
  name = "prepilot-eval-dlq-${var.environment}"

  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600 # 14 days, the SQS maximum

  tags = merge(local.common_tags, { Name = "prepilot-eval-dlq-${var.environment}" })
}

# Declares which queues may send here. Without it the DLQ accepts a redrive from
# any queue in the account — harmless today with one producer, and exactly the
# kind of thing that stops being harmless quietly.
resource "aws_sqs_queue_redrive_allow_policy" "eval_dlq" {
  queue_url = aws_sqs_queue.eval_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.eval.arn]
  })
}
