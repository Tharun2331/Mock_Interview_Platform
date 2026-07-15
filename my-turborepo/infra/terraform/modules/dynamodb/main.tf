resource "aws_dynamodb_table" "sessions" {
  name         = "prepilot-sessions-${var.environment}"
  billing_mode = var.billing_mode
  hash_key     = "userId"
  range_key    = "sessionId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }

  tags = {
    Project     = "prepilot"
    Environment = var.environment
    Table       = "sessions"
  }
}

resource "aws_dynamodb_table" "evaluations" {
  name         = "prepilot-evaluations-${var.environment}"
  billing_mode = var.billing_mode
  hash_key     = "sessionId"
  range_key    = "questionId"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "questionId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }

  tags = {
    Project     = "prepilot"
    Environment = var.environment
    Table       = "evaluations"
  }
}

resource "aws_dynamodb_table" "quiz_history" {
  name         = "prepilot-quiz-history-${var.environment}"
  billing_mode = var.billing_mode
  hash_key     = "userId"
  range_key    = "quizId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "quizId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }

  tags = {
    Project     = "prepilot"
    Environment = var.environment
    Table       = "quiz_history"
  }
}
