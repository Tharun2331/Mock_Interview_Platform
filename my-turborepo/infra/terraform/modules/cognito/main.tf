# 1. Fetch your existing ACM certificate (Must be in us-east-1).
# The dev environment's default provider is already us-east-1.
data "aws_acm_certificate" "issued" {
  domain   = var.aws_acm_domain
  statuses = ["ISSUED"]
}

# 2. Fetch your Route 53 Hosted Zone
data "aws_route53_zone" "primary" {
  name         = var.aws_route53_zone
  private_zone = false
}

# 3. Main Cognito User Pool
resource "aws_cognito_user_pool" "pool" {
  name                     = "preppilot-${var.environment}"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
}

# 4. Google Identity Provider Connection
resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.pool.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "profile email openid"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

# 5. True Custom Domain (Using your ACM SSL Certificate)
resource "aws_cognito_user_pool_domain" "main" {
  domain          = var.aws_acm_custom_domain # Your custom login URL
  certificate_arn = data.aws_acm_certificate.issued.arn
  user_pool_id    = aws_cognito_user_pool.pool.id
}

# 6. Route 53 DNS Record to Route Traffic to Cognito
resource "aws_route53_record" "cognito_domain" {
  name    = aws_cognito_user_pool_domain.main.domain
  type    = "A"
  zone_id = data.aws_route53_zone.primary.zone_id

  alias {
    evaluate_target_health = false
    name                   = aws_cognito_user_pool_domain.main.cloudfront_distribution
    # This specific zone ID is static and mandatory for Cognito CloudFront targets:
    zone_id = "Z2FDTNDATAQYW2"
  }
}

# 7. App Client updated with Custom Domain Redirects & Localhost testing fallback
resource "aws_cognito_user_pool_client" "client" {
  name         = "web-app-client"
  user_pool_id = aws_cognito_user_pool.pool.id

  supported_identity_providers         = ["COGNITO", "Google"]
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["phone", "email", "openid", "profile"]

  # You can keep BOTH production urls and your localhost dev urls active simultaneously!
  callback_urls = [
    "http://localhost:3000/callback",            # Your local dev callback route
    "https://preppilot.tharunsekar.xyz/callback" # Your production callback route

  ]

  logout_urls = [
    "http://localhost:3000",            # Your local dev landing page on logout
    "https://preppilot.tharunsekar.xyz" # Your production landing page on logout

  ]
  id_token_validity      = 1  # Valid for 1 hour
  access_token_validity  = 1  # Valid for 1 hour
  refresh_token_validity = 30 # Valid for 30 days

  depends_on = [aws_cognito_identity_provider.google]
}

  