output "bucket" {
  value = aws_s3_bucket.web.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.web.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.web.arn
}

output "distribution_domain" {
  description = "The distribution's own name, to try it before the DNS name points at it."
  value       = aws_cloudfront_distribution.web.domain_name
}

output "url" {
  value = "https://${var.domain}"
}
