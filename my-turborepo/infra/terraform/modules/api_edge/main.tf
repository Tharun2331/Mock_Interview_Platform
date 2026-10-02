data "aws_route53_zone" "primary" {
  name         = var.route53_zone_name
  private_zone = false
}

data "aws_acm_certificate" "issued" {
  domain      = var.acm_domain
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Every viewer header, cookie and query string except Host. That includes
# Authorization (the REST API's bearer token) and Sec-WebSocket-Protocol (the
# interview socket's), plus the Upgrade headers a WebSocket handshake needs.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

locals {
  common_tags = {
    Project     = "prepilot"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ---------------------------------------------------------------------------
# The API's own distribution, separate from the web app's.
#
# The web app's distribution is on CloudFront's flat-rate Free plan, and VPC
# origins are a Business-plan feature ($200/month). This one stays on
# pay-as-you-go, where VPC origins cost nothing extra and the always-free
# allowance covers this project's traffic. See the ADR-0008 addendum.
#
# The price of a second hostname is that the API is cross-origin: the server's
# CORS_ORIGIN, the web app's CSP connect-src and BUN_PUBLIC_API_URL all name
# this domain.
# ---------------------------------------------------------------------------

# CloudFront's entry into the VPC. Traffic arrives at the instance from
# CloudFront-managed ENIs in the private subnet over AWS's network, so the
# instance keeps no public IP. Plain HTTP on that hop: TLS terminates at the
# edge, and the hop never leaves the VPC.
resource "aws_cloudfront_vpc_origin" "api" {
  vpc_origin_endpoint_config {
    name                   = "prepilot-api-${var.environment}"
    arn                    = var.instance_arn
    http_port              = var.app_port
    https_port             = 443
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }

  tags = local.common_tags
}

# Creating a VPC origin makes AWS create this security group in the VPC; the
# instance admits traffic from it and nothing else. A data lookup by name is
# the exception to wiring through outputs (infra/terraform/CLAUDE.md): the
# group is AWS-owned, so no module of ours can output it. depends_on defers the
# read until the VPC origin, and with it the group, exists.
data "aws_security_group" "cloudfront_vpc_origins" {
  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }

  depends_on = [aws_cloudfront_vpc_origin.api]
}

resource "aws_vpc_security_group_ingress_rule" "from_cloudfront" {
  security_group_id            = var.instance_security_group_id
  description                  = "API traffic from CloudFront VPC origin"
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origins.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"

  tags = local.common_tags
}

resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  comment         = "PrepPilot API (${var.environment})"
  aliases         = [var.api_domain]
  is_ipv6_enabled = true
  http_version    = "http2and3"
  # North America and Europe edges only. The cheapest class, and the origin is
  # in us-east-1 anyway.
  price_class = "PriceClass_100"

  origin {
    origin_id   = "api"
    domain_name = var.instance_private_dns

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.api.id
      # The default 30s is shorter than a /plan call on a slow Bedrock
      # fallback. 60 is the most CloudFront allows without a quota increase.
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }
  }

  default_cache_behavior {
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = data.aws_acm_certificate.issued.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = local.common_tags

  # The instance must admit CloudFront before CloudFront starts sending.
  depends_on = [aws_vpc_security_group_ingress_rule.from_cloudfront]
}

resource "aws_route53_record" "api" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = var.api_domain
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.api.domain_name
    zone_id                = aws_cloudfront_distribution.api.hosted_zone_id
    evaluate_target_health = false
  }
}
