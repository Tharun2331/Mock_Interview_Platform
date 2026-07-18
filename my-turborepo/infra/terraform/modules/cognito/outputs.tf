output "google_client_id_parameter_name" {
  value = aws_ssm_parameter.google_client_id.name
}

output "google_client_secret_parameter_name" {
  value = aws_ssm_parameter.google_client_secret.name
}
