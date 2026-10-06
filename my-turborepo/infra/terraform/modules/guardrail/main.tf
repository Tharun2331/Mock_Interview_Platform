locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  enforcing = var.mode == "enforce"

  # NONE is detect mode: the policy evaluates and the finding appears in the
  # Converse trace, but the request goes through untouched.
  block_action = local.enforcing ? "BLOCK" : "NONE"
  pii_action   = local.enforcing ? "ANONYMIZE" : "NONE"

  content_filter_types = ["HATE", "INSULTS", "SEXUAL", "VIOLENCE", "MISCONDUCT"]
}

# One guardrail for the six text agents (ADR-0010). Attached per call through
# Converse's guardrailConfig in apps/servers/lib/bedrock.ts.
#
# Not attached to the Nova 2 Sonic voice loop, and it cannot be: the
# bidirectional stream request has no guardrail field.
#
# What it sees: the user turn, which the server wraps in guardContent, and the
# model's output. Not the system prompt and not the few-shot exemplars — both
# are written by this codebase, so scanning them buys only false positives.
resource "aws_bedrock_guardrail" "text" {
  name        = "prepilot-text-${var.environment}"
  description = "Prompt-attack, content and PII checks on PrepPilot's text agents (${var.mode} mode)."

  # Never shown to a candidate. The server detects a block by the
  # guardrail_intervened stop reason and maps it to its own copy; these exist
  # because the API requires them, and are worded so that one reaching a log or
  # a stored item by mistake is recognisable.
  blocked_input_messaging   = "[prepilot guardrail] input blocked"
  blocked_outputs_messaging = "[prepilot guardrail] output blocked"

  content_policy_config {
    dynamic "filters_config" {
      for_each = toset(local.content_filter_types)

      content {
        type            = filters_config.value
        input_strength  = var.content_filter_strength
        output_strength = var.content_filter_strength
        input_action    = local.block_action
        output_action   = local.block_action
        input_enabled   = true
        output_enabled  = true
      }
    }

    # Input only, by AWS's rule: PROMPT_ATTACK must have an output strength of
    # NONE. It is the filter this guardrail exists for — a stranger's README is
    # the clearest injection path into the product.
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = var.prompt_attack_strength
      output_strength = "NONE"
      input_action    = local.block_action
      input_enabled   = true
      output_enabled  = false
    }
  }

  # Output only, and anonymize rather than block. Input is redacted by
  # Comprehend before any model sees it, so scanning it again would pay twice
  # for the same job.
  sensitive_information_policy_config {
    dynamic "pii_entities_config" {
      for_each = toset(var.pii_output_entities)

      content {
        type           = pii_entities_config.value
        action         = "ANONYMIZE"
        input_enabled  = false
        output_enabled = true
        output_action  = local.pii_action
      }
    }
  }

  # Absent in detect mode, deliberately. topics_config has no per-topic action
  # in hashicorp/aws 6.54 (verified against the provider schema), so a denied
  # topic would block from the moment it exists while every other policy only
  # watches. Created when the guardrail is switched to enforce.
  dynamic "topic_policy_config" {
    for_each = local.enforcing && length(var.denied_topics) > 0 ? [1] : []

    content {
      dynamic "topics_config" {
        for_each = var.denied_topics

        content {
          name       = topics_config.value.name
          definition = topics_config.value.definition
          examples   = topics_config.value.examples
          type       = "DENY"
        }
      }
    }
  }

  tags = local.common_tags
}

# The numbered snapshot the application calls. Never DRAFT: a console edit or a
# half-applied change to the draft must not change what production does.
#
# A version is frozen at creation, so without replace_triggered_by a filter
# change would update the draft only and the app would keep calling the old
# behaviour indefinitely.
#
# skip_destroy keeps the previous version when a new one replaces it. The API
# server reads BEDROCK_GUARDRAIL_VERSION only when its service starts, so until
# it is restarted it still names the old number — deleting that version at
# apply time would fail every text call in the gap.
resource "aws_bedrock_guardrail_version" "this" {
  guardrail_arn = aws_bedrock_guardrail.text.guardrail_arn
  description   = "${var.mode} mode"
  skip_destroy  = true

  lifecycle {
    replace_triggered_by = [aws_bedrock_guardrail.text]
  }
}
