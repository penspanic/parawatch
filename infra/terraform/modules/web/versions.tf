terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
      # CloudFront takes certificates only from us-east-1
      configuration_aliases = [aws.us_east_1]
    }
  }
}
