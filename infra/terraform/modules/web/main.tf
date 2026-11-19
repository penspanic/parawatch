# The phone web app as static files: a private S3 bucket behind CloudFront, with a certificate and
# the DNS name. The files themselves are uploaded by the deploy workflow, not here.
#
# Every file is uploaded with "Cache-Control: no-cache" (the names are fixed, not hashed), and the
# cache policy follows it: CloudFront asks the bucket each time whether a file changed, so a new
# version of the app and its service worker never mixes with the old one.

resource "aws_s3_bucket" "web" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = var.bucket_name
  description                       = "CloudFront reads ${var.bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# only this distribution may read the bucket
data "aws_iam_policy_document" "web" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web.json
}

resource "aws_acm_certificate" "web" {
  provider          = aws.us_east_1
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = { for o in aws_acm_certificate.web.domain_validation_options : o.domain_name => o }
  zone_id  = var.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  ttl      = 300
  records  = [each.value.resource_record_value]
}

resource "aws_acm_certificate_validation" "web" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.web.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

data "aws_cloudfront_cache_policy" "origin_headers" {
  name = "UseOriginCacheControlHeaders"
}

# the same headers Caddy sent when the relay server served the app
resource "aws_cloudfront_response_headers_policy" "web" {
  name = replace(var.bucket_name, ".", "-")
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "parawatch web app: ${var.domain}"
  aliases             = [var.domain]
  default_root_object = "index.html"
  price_class         = var.price_class

  origin {
    origin_id                = "s3"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id           = "s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.origin_headers.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.web.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.web.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "app" {
  zone_id = var.zone_id
  name    = var.domain
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "app_ipv6" {
  zone_id = var.zone_id
  name    = var.domain
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}
