output "guardrail_id" {
  description = "Guardrail id, for the services' BEDROCK_GUARDRAIL_ID."
  value       = aws_bedrock_guardrail.text.guardrail_id
}

output "guardrail_arn" {
  description = "Guardrail ARN, for scoping bedrock:ApplyGuardrail on the server and Evaluator roles to this guardrail alone."
  value       = aws_bedrock_guardrail.text.guardrail_arn
}

output "guardrail_version" {
  description = "The numbered version the services call, for BEDROCK_GUARDRAIL_VERSION. Changes whenever the guardrail's configuration does."
  value       = aws_bedrock_guardrail_version.this.version
}
