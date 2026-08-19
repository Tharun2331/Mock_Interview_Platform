locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # Foundation-model ARNs carry no account id — the empty segment before
  # `:foundation-model/` is intentional, not a interpolation bug.
  text_model_arns = [
    for id in var.bedrock_text_model_ids :
    "arn:aws:bedrock:${var.aws_region}::foundation-model/${id}"
  ]

  speech_model_arn = "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_speech_model_id}"
}

# Two statements rather than one action list over one resource list. The text
# agents and the voice loop need different Bedrock actions on different models,
# and a merged statement would grant the bidirectional-stream action on every
# text model too.
#
# That separation is also what lets the Evaluator worker role reuse the text
# half in Phase 5 without ever gaining permission to open an audio stream.
data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    sid    = "BedrockInvokeText"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = local.text_model_arns
  }

  # Scoped to Nova 2 Sonic alone. A bidirectional stream bills for as long as it
  # stays open, so this permission is deliberately narrower than the text one.
  statement {
    sid       = "BedrockInvokeSpeechBidirectional"
    effect    = "Allow"
    actions   = ["bedrock:InvokeModelWithBidirectionalStream"]
    resources = [local.speech_model_arn]
  }
}

data "aws_iam_policy_document" "server_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "bedrock_invoke" {
  name        = "prepilot-bedrock-invoke-${var.environment}"
  description = "Allow PrepPilot server to invoke Bedrock text and speech models (${var.environment})"
  policy      = data.aws_iam_policy_document.bedrock_invoke.json

  tags = local.common_tags
}

resource "aws_iam_role" "server" {
  name               = "prepilot-server-role-${var.environment}"
  assume_role_policy = data.aws_iam_policy_document.server_assume_role.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "server_bedrock" {
  role       = aws_iam_role.server.name
  policy_arn = aws_iam_policy.bedrock_invoke.arn
}
