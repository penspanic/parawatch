# The relay and phone web app at parawatch.penspanic.com.

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

provider "aws" {
  region = "ap-northeast-2"
  default_tags {
    tags = {
      project = "parawatch"
      env     = "prod"
    }
  }
}

module "relay" {
  source            = "../../modules/relay"
  name              = "parawatch-relay"
  availability_zone = "ap-northeast-2a"
  zone_name         = "penspanic.com"
  relay_domain      = "relay.parawatch.penspanic.com"
  app_domain        = "parawatch.penspanic.com"
}

output "relay_url" {
  value = module.relay.relay_url
}

output "app_url" {
  value = module.relay.app_url
}

output "ip_address" {
  value = module.relay.ip_address
}
