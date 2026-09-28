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

  # The admin surface's user directory: email -> sub lookup, and the user table.
  #
  # `ListUsers` and nothing else. Notably NOT `AdminGetUser`, which would also
  # resolve an email — ListUsers with a filter answers the same question and is the
  # one call that ALSO serves the paginated table, so granting both would be a
  # second way to do something already covered.
  #
  # **Still no AdminUpdateUserAttributes, AdminAddUserToGroup or
  # AdminSetUserPassword.** The admin API grants interview quota, which lives on a
  # DynamoDB item — it never mutates a Cognito identity. Group membership is
  # deliberately an operational act performed with the AWS CLI rather than
  # something this service can do, which is what stops a compromised API token
  # from making its holder an admin. See the note on aws_cognito_user_group in the
  # cognito module.
  #
  # This grant is the concrete cost of choosing Cognito over a DynamoDB GSI for
  # email lookup: one read action on the pool, against a GSI's doubled write cost
  # on every profile save plus an email attribute and a backfill. It is also the
  # only way to enumerate users at all — the sessions table has no keyed listing,
  # so the alternative was a Scan, which the statement below deliberately withholds.
  statement {
    sid       = "CognitoListUsersForAdmin"
    effect    = "Allow"
    actions   = ["cognito-idp:ListUsers"]
    resources = [var.cognito_user_pool_arn]
  }

  # Reading custom metrics back for GET /api/v1/admin/metrics.
  #
  # Read-only, and the omission that matters is `cloudwatch:PutMetricData`. The
  # service publishes metrics as EMF on stdout — see apps/servers/lib/metrics.ts —
  # so it never calls the metrics API to write. Granting PutMetricData "because it
  # does metrics" would hand a compromised task the ability to forge the very
  # series these alarms fire on, which is the one thing that would make the alarms
  # worse than useless.
  #
  # `"*"` is unavoidable here and this is the comment naming why: neither
  # GetMetricData nor ListMetrics supports resource-level permissions. CloudWatch
  # metrics are not resources with ARNs, and there is no namespace condition key
  # for these actions — `cloudwatch:namespace` applies to PutMetricData only, which
  # is precisely the action not granted. The control is therefore the action list,
  # and it is two read calls.
  statement {
    sid    = "CloudWatchReadMetrics"
    effect = "Allow"
    actions = [
      "cloudwatch:GetMetricData",
      "cloudwatch:ListMetrics",
    ]
    resources = ["*"]
  }

  # Writing logs, which is also how metrics come into existence.
  #
  # Worth stating plainly because it is not obvious: this is not just a logging
  # grant. Custom metrics are emitted as EMF log lines and extracted by CloudWatch
  # Logs at ingestion, so `logs:PutLogEvents` on this group IS the metric-publishing
  # permission. Remove it and every alarm in the cloudwatch module goes to
  # INSUFFICIENT_DATA while the service keeps running perfectly.
  #
  # Scoped to the one log group and its streams. No `logs:CreateLogGroup`:
  # Terraform owns the group, and a service that can create groups can create them
  # outside the retention policy — which is the quiet way a log bill grows.
  statement {
    sid    = "ApiLogWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      var.api_log_group_arn,
      "${var.api_log_group_arn}:*",
    ]
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

  # Enqueue only. The API produces evaluation jobs when an interview ends and
  # never consumes them — ReceiveMessage and DeleteMessage belong to the worker
  # role alone, and granting them here would let a compromised API service drain
  # the queue and silently discard a candidate's feedback.
  statement {
    sid       = "EvalQueueSend"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [var.eval_queue_arn]
  }

}

# ---------------------------------------------------------------------------
# Evaluator worker role
#
# Separate from the server role, never shared. The concrete payoff is the
# permission that is ABSENT: no bedrock:InvokeModelWithBidirectionalStream. The
# worker scores text and has no reason to open an audio stream, so if it is ever
# compromised or looped by a bug it cannot open a billable Sonic stream.
#
# Also absent: S3 (it never touches a resume), Cognito (it never deletes a
# user), and Comprehend (redaction runs once at profile save, on the API side).
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "evaluator_worker" {
  # The text half of the server's Bedrock grant, and only the text half.
  statement {
    sid    = "BedrockInvokeText"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = local.text_model_arns
  }

  # Reads the answer and the session meta, writes the evaluation.
  #
  # **This cannot be scoped to EVAL#* items.** `overview.md` §8 describes the
  # worker's DynamoDB grant as "write on EVAL#* items only", and IAM has no way
  # to express that: the only item-level condition key is
  # `dynamodb:LeadingKeys`, which constrains the PARTITION key, and `EVAL#` is a
  # sort-key prefix. There is no sort-key condition.
  #
  # What is enforceable is the action list, and it is deliberately narrower than
  # the server's: no DeleteItem, no UpdateItem, no BatchWriteItem. The worker
  # can add an evaluation and read what it needs to produce one. It cannot
  # remove a transcript, mutate a session's status, or run an erasure sweep.
  statement {
    sid    = "SessionsTableEvaluationAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]
    resources = [var.sessions_table_arn]
  }

  # Consume only. No SendMessage: a worker that could enqueue could loop itself,
  # and every message it wrote would cost a Bedrock generation to process.
  statement {
    sid    = "EvalQueueConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      # Needed by ReceiveMessage's long-poll path and by any future visibility
      # extension for a slow generation.
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [var.eval_queue_arn]
  }

  # Its OWN log group, not the API's.
  #
  # This is the logging half of the two-roles separation, and it is load-bearing
  # rather than tidy. Custom metrics are EMF log lines extracted at ingestion, so
  # write access to the API's log group is write access to the API's metrics — and
  # the alarms in the cloudwatch module fire on those. A worker granted the API's
  # group could suppress a 5xx alarm or manufacture one. It has no reason to write
  # there and does not.
  #
  # Also absent, as everywhere else on this role: no cloudwatch:GetMetricData. The
  # worker produces no dashboard and reads no metrics.
  statement {
    sid    = "WorkerLogWrite"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      var.worker_log_group_arn,
      "${var.worker_log_group_arn}:*",
    ]
  }
}

resource "aws_iam_policy" "evaluator_worker" {
  name        = "prepilot-evaluator-worker-${var.environment}"
  description = "Allow the PrepPilot Evaluator worker to consume the eval queue, invoke text models, and write evaluations (${var.environment})"
  policy      = data.aws_iam_policy_document.evaluator_worker.json

  tags = local.common_tags
}

resource "aws_iam_role" "evaluator_worker" {
  name = "prepilot-evaluator-worker-role-${var.environment}"
  # Same trust policy as the server: both are ECS tasks. The separation is in
  # what each role permits, not in who may assume it.
  assume_role_policy = data.aws_iam_policy_document.server_assume_role.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "evaluator_worker" {
  role       = aws_iam_role.evaluator_worker.name
  policy_arn = aws_iam_policy.evaluator_worker.arn
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
