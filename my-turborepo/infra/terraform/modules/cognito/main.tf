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

  # Stated rather than inherited. These are Cognito's defaults, and
  # SignUpSchema in packages/shared/src/schemas/auth.ts mirrors them, so the
  # browser rejects exactly what the pool would. Declaring them means a
  # console edit shows up as drift instead of silently diverging from the form.
  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  # TOTP available, never forced. OPTIONAL changes nothing for a candidate who
  # has not enrolled, so this is safe to apply before the web app has an
  # enrolment screen. Until it does, only the API can enrol a user, and the
  # sign-in page does not yet handle the TOTP challenge step. SMS MFA is not
  # enabled: it needs an SNS spend limit and an origination identity.
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  # An email change stays pending until the new address is verified, and the
  # old one keeps working meanwhile. Without this, UpdateUserAttributes swapped
  # the sign-in email immediately to an address nobody had proven they own,
  # and the admin surface resolves accounts by email.
  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  # Threat protection (compromised-credential checks, adaptive sign-in risk)
  # needs the PLUS feature tier, which is billed per monthly active user, so it
  # is a variable rather than switched on here. null leaves the tier the pool
  # already has.
  user_pool_tier = var.threat_protection_mode == "OFF" ? null : "PLUS"

  dynamic "user_pool_add_ons" {
    for_each = var.threat_protection_mode == "OFF" ? [] : [var.threat_protection_mode]
    content {
      advanced_security_mode = user_pool_add_ons.value
    }
  }

  # Deleting the pool deletes every account in it, with no undo.
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  # The free substitute for threat protection: refuses disposable-mail domains
  # and + sub-addressing at sign-up. See pre_sign_up.tf.
  lambda_config {
    pre_sign_up = aws_lambda_function.pre_sign_up.arn
  }
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
  lifecycle {
    ignore_changes = [provider_details]
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
  # aws.cognito.signin.user.admin is the scope that gates every self-service
  # Cognito API — GetUser, ChangePassword, and the whole MFA management
  # family (AssociateSoftwareToken, SetUserMFAPreference, and by extension
  # fetchMFAPreference/setUpTOTP/verifyTOTPSetup/updateMFAPreference in
  # Amplify). A native sign-in (signIn(), USER_SRP_AUTH) gets it on its access
  // token automatically; the Hosted UI / OAuth code exchange used by Google
  // sign-in only grants what is listed here. Its absence produced
  // "NotAuthorizedException: Access Token does not have required scopes" for
  // every Google-authenticated candidate who opened Settings > Security — not
  // a federated-user limitation, just this one scope never being requested.
  allowed_oauth_scopes = [
    "phone",
    "email",
    "openid",
    "profile",
    "aws.cognito.signin.user.admin",
  ]

  # Only this environment's URLs. One client used to accept both localhost and
  # production, so a production sign-in code could be sent to
  # http://localhost:3000, where anything listening locally could catch it.
  # Each environment's pool now lists its own pages and nothing else.
  callback_urls = [for origin in var.app_origins : "${origin}/callback"]
  logout_urls   = var.app_origins
  # Sign-in and password reset answer the same way whether or not the account
  # exists. The web app already shows one message for both, but that only
  # covered the UI: anyone calling InitiateAuth or ForgotPassword directly
  # could tell UserNotFoundException from NotAuthorizedException and build a
  # list of registered emails. Left unset, the API defaults to LEGACY, which
  # reveals it. Sign-up still has to say an address is taken; that is inherent
  # to open sign-up and is what the rate limits in Cognito bound.
  prevent_user_existence_errors = "ENABLED"

  # Refresh tokens can be revoked (sign-out, account deletion). The default,
  # stated so it cannot be switched off unnoticed.
  enable_token_revocation = true

  id_token_validity     = 1 # Valid for 1 hour
  access_token_validity = 1 # Valid for 1 hour
  # 7 days, not 30. Amplify keeps this token in localStorage, so it is the one a
  # script injection would steal; the lifetime is how long that theft stays
  # useful. A candidate who has not opened the app for a week signs in again.
  refresh_token_validity = 7 # Valid for 7 days

  # Refresh-token rotation is deliberately NOT enabled. Cognito refuses it while
  # ALLOW_REFRESH_TOKEN_AUTH is an allowed flow ("ALLOW_REFRESH_TOKEN_AUTH is not
  # a permitted ExplicitAuthFlow when refresh token rotation is enabled",
  # confirmed against dev 2026-10-01), and Amplify refreshes through exactly that
  # flow, so enabling it would stop every session renewing after an hour.
  # Rotation only covers the OAuth /oauth2/token refresh grant.

  depends_on = [aws_cognito_identity_provider.google]
}

# 8. Admin group.
#
# Membership in this group is the whole of the admin authorisation model. Cognito
# puts it on the access token as `cognito:groups`, which the server already
# verifies for every request, so `lib/adminAuth.ts` needs no extra API call, no
# cache, and no second source of truth.
#
# The alternative considered was an ADMIN_USER_IDS allowlist in the server's
# config. Rejected because membership would then be a deploy: adding an admin
# means editing an environment variable and restarting the service, and the list
# is written in opaque Cognito subs that nobody can read back.
#
# **Terraform deliberately does not manage membership.** There is an
# `aws_cognito_user_in_group` resource and it is not used here, because putting a
# member in state means the person's Cognito username sits in a plaintext state
# file and every membership change becomes an apply against live auth. The group
# is infrastructure; who is in it is an operational act:
#
#   aws cognito-idp admin-add-user-to-group \
#     --user-pool-id <pool id> --username <email> --group-name admins
#
# `precedence` is unset on purpose. It only matters for resolving the IAM role
# claim when a user belongs to several groups, and there is exactly one group.
resource "aws_cognito_user_group" "admins" {
  name         = var.admin_group_name
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = "Members reach the PrepPilot admin API (${var.environment})"
}

  