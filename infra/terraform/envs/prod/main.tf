# The relay at relay.parawatch.penspanic.com and the phone web app at parawatch.penspanic.com.
# Applied by the Deploy workflow after the owner approves its plan (see ../../README.md).

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  backend "s3" {
    bucket       = "parawatch-tfstate-penspanic"
    key          = "prod/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}

locals {
  tags = {
    project = "parawatch"
    env     = "prod"
  }
}

provider "aws" {
  region = "ap-northeast-2"
  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = local.tags
  }
}

module "relay" {
  source            = "../../modules/relay"
  name              = "parawatch-relay"
  availability_zone = "ap-northeast-2a"
  zone_name         = "penspanic.com"
  relay_domain      = "relay.parawatch.penspanic.com"
}

module "web" {
  source      = "../../modules/web"
  bucket_name = "parawatch-web-penspanic"
  domain      = "parawatch.penspanic.com"
  zone_id     = module.relay.zone_id
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
}

# the web app's name pointed at the relay server until 0.3.27; it now points at CloudFront
moved {
  from = module.relay.aws_route53_record.app[0]
  to   = module.web.aws_route53_record.app
}

output "relay_url" {
  value = module.relay.relay_url
}

output "relay_domain" {
  value = module.relay.relay_domain
}

output "app_url" {
  value = module.web.url
}

output "app_domain" {
  value = "parawatch.penspanic.com"
}

output "ip_address" {
  value = module.relay.ip_address
}

output "instance_name" {
  value = module.relay.instance_name
}

output "instance_arn" {
  value = module.relay.instance_arn
}

output "zone_id" {
  value = module.relay.zone_id
}

output "web_bucket" {
  value = module.web.bucket
}

output "web_bucket_arn" {
  value = module.web.bucket_arn
}

output "web_distribution_id" {
  value = module.web.distribution_id
}

output "web_distribution_arn" {
  value = module.web.distribution_arn
}

output "web_distribution_domain" {
  value = module.web.distribution_domain
}
