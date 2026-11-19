variable "bucket_name" {
  description = "S3 bucket that holds the built web app (apps/web/dist). Private; only the CloudFront distribution reads it."
  type        = string
}

variable "domain" {
  description = "Name the phone web app is served at, such as parawatch.example.com."
  type        = string
}

variable "zone_id" {
  description = "Route 53 hosted zone the name lives in."
  type        = string
}

variable "price_class" {
  description = "CloudFront edge locations to use. PriceClass_200 includes Korea and Japan; PriceClass_100 is North America and Europe only."
  type        = string
  default     = "PriceClass_200"
}
