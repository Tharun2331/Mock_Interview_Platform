locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Single table for every durable interview record — sessions, transcripts,
# evaluations, coaching. Key layout and item shapes are specified in
# docs/architecture/data-model.md §1; this file provisions it and nothing more.
#
#   PK                SK              Purpose
#   ────────────────────────────────────────────────────────────
#   SESSION#<sid>     META            session metadata + plan
#   SESSION#<sid>     ANSWER#<qId>    question + candidate transcript
#   SESSION#<sid>     EVAL#<qId>      per-answer scores
#   SESSION#<sid>     EVAL#SUMMARY    rollup
#   SESSION#<sid>     COACH           improvement plan
#   USER#<uid>        SESSION#<sid>   user history lookup
#
# ULIDs rather than UUIDs for sid and qId: they sort lexicographically by
# creation time, so `Query begins_with ANSWER#` returns answers in the order
# they were asked with no sequence attribute and no client-side sort.
resource "aws_dynamodb_table" "sessions" {
  name = "prepilot-sessions-${var.environment}"

  # On-demand. The alternative is provisioned at the free tier's 25 WCU, which
  # would make this table cost nothing — but the flush at the end of a session
  # writes roughly twenty items at once, which lands above that ceiling and
  # relies on burst credits absorbing it. That is a throttle cliff in the write
  # path that persists the interview transcript, traded for about ten cents a
  # month. Not worth it.
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  # Only key attributes are declared. DynamoDB is schemaless for everything
  # else, and declaring a non-key attribute here is an error rather than
  # documentation — the item shapes live in Zod schemas instead.
  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # No global secondary index, deliberately. overview.md §6 calls for one on SK
  # for user history, but the USER#<uid> / SESSION#<sid> lookup item makes that
  # a plain base-table Query — data-model.md §1 works through why. A GSI is a
  # full second copy of every projected item, so it would double write cost and
  # storage to serve an access pattern that is already covered.

  # No `server_side_encryption` block, deliberately. Its absence means the
  # AWS-owned key, which is free and encrypts at rest exactly the same. Adding
  # the block switches to a KMS key that bills per API call and puts a KMS
  # availability dependency inside the live interview write path. It reads like
  # a security upgrade and is not one.

  point_in_time_recovery {
    enabled = var.point_in_time_recovery_enabled
  }

  dynamic "ttl" {
    for_each = var.ttl_attribute_name == null ? [] : [var.ttl_attribute_name]

    content {
      enabled        = true
      attribute_name = ttl.value
    }
  }

  deletion_protection_enabled = var.deletion_protection_enabled

  tags = local.common_tags
}
