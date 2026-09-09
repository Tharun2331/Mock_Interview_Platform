data "aws_caller_identity" "current" {}

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # An id prefixed with a region code (`us.`) is a system-defined cross-region
  # inference profile, not a foundation model, and the two take different ARN
  # shapes. Some models are only invocable through a profile — Llama 4 Scout
  # returns "Invocation of model ID ... with on-demand throughput isn't
  # supported" for the bare id — so the chain has to carry both kinds.
  inference_profile_ids = [
    for id in var.bedrock_text_model_ids : id
    if startswith(id, "us.")
  ]

  foundation_model_ids = [
    for id in var.bedrock_text_model_ids : id
    if !startswith(id, "us.")
  ]

  # Foundation-model ARNs carry no account id — the empty segment before
  # `:foundation-model/` is intentional, not a interpolation bug. Inference
  # profiles are the opposite: they are account-scoped resources.
  foundation_model_arns = [
    for id in local.foundation_model_ids :
    "arn:aws:bedrock:${var.aws_region}::foundation-model/${id}"
  ]

  inference_profile_arns = [
    for id in local.inference_profile_ids :
    "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${id}"
  ]

  # A cross-region profile forwards the request into one of its member regions
  # and the invoke is authorised against the foundation model *there*, not in
  # the calling region. Granting only the profile ARN produces an AccessDenied
  # that names a region the config never mentions.
  inference_profile_model_arns = flatten([
    for id in local.inference_profile_ids : [
      for region in var.inference_profile_regions :
      "arn:aws:bedrock:${region}::foundation-model/${trimprefix(id, "us.")}"
    ]
  ])

  text_model_arns = concat(
    local.foundation_model_arns,
    local.inference_profile_arns,
    local.inference_profile_model_arns,
  )

  speech_model_arn = "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.bedrock_speech_model_id}"

  # Object-level ARNs, one per allowed prefix. Deliberately not
  # "${bucket}/*" — that would let a path bug write anywhere in the bucket,
  # including over the frontend assets if the buckets are ever merged.
  upload_object_arns = [
    for prefix in var.upload_prefixes :
    "${var.uploads_bucket_arn}/${prefix}/*"
  ]
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

  # Resumes in, resumes back out, and now deletable.
  #
  # DeleteObject was deliberately withheld while nothing removed uploads. That
  # is no longer true: erasure has to be able to remove a candidate's resume, and
  # a right that cannot be exercised is not a right. The blast radius stays
  # bounded by the prefix scoping in local.upload_object_arns — this cannot
  # reach the frontend bucket or anything outside `resumes/`.
  #
  # No ListBucket, which erasure would otherwise need to enumerate objects.
  # Storing the resume at one stable key per user removed the need: the sweep
  # deletes a key it can compute, so the server never gains the ability to
  # enumerate what other candidates have uploaded.
  statement {
    sid    = "UploadsObjectAccess"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = local.upload_object_arns
  }

  # Erasure only. Scoped to the one pool, and deliberately not the wider admin
  # surface: no AdminCreateUser, no AdminSetUserPassword, no AdminUpdate*. The
  # server authenticates users against a public JWKS and never needs to manage
  # them — deleting one on their own request is the single exception.
  statement {
    sid       = "CognitoDeleteOwnUser"
    effect    = "Allow"
    actions   = ["cognito-idp:AdminDeleteUser"]
    resources = [var.cognito_user_pool_arn]
  }

  # PII detection on resume text, run once at profile save before the text is
  # stored or reaches a model.
  #
  # No resource scoping is possible: DetectPiiEntities is a stateless analysis
  # call that owns nothing, so it takes "*" — the same shape AWS documents for
  # it. The action list is the control here, and it is deliberately one action.
  # The async job APIs (StartPiiEntitiesDetectionJob and friends) read and write
  # S3 on the caller's behalf and are not granted.
  #
  # Comprehend is not Bedrock, which is worth naming against the "all AI through
  # Bedrock" decision in CLAUDE.md: that rule is about model inference and the
  # agents behind it. This is a managed detection API, chosen over a Bedrock
  # text model because a purpose-built PII detector beats an LLM at recall on
  # the one job that must not silently miss anything. See ADR (step 6).
  statement {
    sid       = "ComprehendDetectPii"
    effect    = "Allow"
    actions   = ["comprehend:DetectPiiEntities"]
    resources = ["*"]
  }

  # Scoped to the one table, with no index ARN because the table has no GSI.
  # Every access pattern in data-model.md §1 is a GetItem or a Query on the
  # base table.
  #
  # DeleteItem is granted now that erasure exists. The earlier note here said
  # nothing in the application deletes session data because it is the product —
  # still true of the interview flow, and now untrue of a candidate exercising
  # their right to have it removed.
  #
  # BatchWriteItem could already delete, so this closes a gap between what the
  # policy said and what it permitted rather than widening one.
  #
  # No Scan, unchanged: every read is keyed, including the erasure sweep, which
  # Queries the two partitions it owns. A Scan on this table would be a bug that
  # bills like a feature.
  statement {
    sid    = "SessionsTableAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchWriteItem",
      "dynamodb:BatchGetItem",
    ]
    resources = [var.sessions_table_arn]
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
