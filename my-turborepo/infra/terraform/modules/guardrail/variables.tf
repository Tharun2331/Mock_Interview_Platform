variable "environment" {
  type        = string
  description = "Deployment environment (dev | prod)"
}

variable "mode" {
  type        = string
  description = "detect: every filter evaluates and reports in the trace but blocks nothing, and denied topics are left out entirely because they have no per-topic action and would block regardless. enforce: filters block, PII is anonymized, and denied topics are created. Roll out through detect first — see ADR-0010."

  validation {
    condition     = contains(["detect", "enforce"], var.mode)
    error_message = "mode must be \"detect\" or \"enforce\"."
  }
}

variable "content_filter_strength" {
  type        = string
  description = "Strength of the hate, insults, sexual, violence and misconduct filters, on input and output. MEDIUM by default rather than HIGH: candidates talk about SQL injection, exploits and killing processes, and a blocked Evaluator call costs them their feedback."
  default     = "MEDIUM"

  validation {
    condition     = contains(["NONE", "LOW", "MEDIUM", "HIGH"], var.content_filter_strength)
    error_message = "content_filter_strength must be NONE, LOW, MEDIUM or HIGH."
  }
}

variable "prompt_attack_strength" {
  type        = string
  description = "Strength of the prompt-attack filter, input only. Separate from the content filters because it is the reason this guardrail exists and is the first thing to tune from detect-mode findings: a README quoting 'ignore previous instructions' as an example is a likely false positive."
  default     = "MEDIUM"

  validation {
    condition     = contains(["NONE", "LOW", "MEDIUM", "HIGH"], var.prompt_attack_strength)
    error_message = "prompt_attack_strength must be NONE, LOW, MEDIUM or HIGH."
  }
}

variable "pii_output_entities" {
  type        = list(string)
  description = "PII types anonymized in model OUTPUT only. Input is already redacted by Comprehend (ADR-0007); this catches a model inventing or echoing one. NAME is deliberately absent: Coach and Evaluator prose names technologies and their authors, and anonymizing those mangles feedback for no privacy gain."
  default = [
    "EMAIL",
    "PHONE",
    "ADDRESS",
    "US_SOCIAL_SECURITY_NUMBER",
    "CREDIT_DEBIT_CARD_NUMBER",
  ]
}

variable "denied_topics" {
  type = list(object({
    name       = string
    definition = string
    examples   = list(string)
  }))
  description = "Topics the text agents must not give advice on. Created only in enforce mode. Kept short on purpose: each topic is one more way a legitimate interview answer can be refused."
  default = [
    {
      name       = "Legal advice"
      definition = "Advice on legal rights, contracts, employment law, lawsuits or how to handle a legal dispute."
      examples = [
        "Can my employer legally fire me for this?",
        "Should I sign this non-compete agreement?",
      ]
    },
    {
      name       = "Medical advice"
      definition = "Diagnosis, treatment or medication guidance for a physical or mental health condition."
      examples = [
        "What medication should I take for interview anxiety?",
        "Do my symptoms mean I have burnout or depression?",
      ]
    },
    {
      name       = "Immigration advice"
      definition = "Guidance on visa eligibility, work permits, immigration status or immigration applications."
      examples = [
        "Am I eligible for an H-1B visa?",
        "Can I work while my permit renewal is pending?",
      ]
    },
  ]
}
