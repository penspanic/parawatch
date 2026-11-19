# The AWS roles the Deploy workflow (.github/workflows/deploy.yml) takes through GitHub's OIDC
# tokens. Kept apart from envs/prod on purpose: the deploy role applies envs/prod, so it must not be
# able to change its own permissions. Only the owner applies this, from their own machine, after
# envs/prod (it reads the names of what it grants from prod's state).
#
#   plan   GitHub environment "plan" (main and v* tags only): reads everything, changes nothing.
#   deploy GitHub environment "production" (the owner approves each run): applies envs/prod, logs in
#          to the relay server to set it up, uploads the web app.

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
    key          = "ci/terraform.tfstate"
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
      env     = "ci"
    }
  }
}

locals {
  repo         = "penspanic/parawatch"
  state_bucket = "parawatch-tfstate-penspanic"
  prod         = data.terraform_remote_state.prod.outputs
}

data "aws_caller_identity" "me" {}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "terraform_remote_state" "prod" {
  backend = "s3"
  config = {
    bucket = local.state_bucket
    key    = "prod/terraform.tfstate"
    region = "ap-northeast-2"
  }
}

# a job of this repository running in the named GitHub environment, and nothing else
data "aws_iam_policy_document" "trust" {
  for_each = { plan = "plan", deploy = "production" }
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.repo}:environment:${each.value}"]
    }
  }
}

# reading what envs/prod manages: enough for `terraform plan -lock=false`
data "aws_iam_policy_document" "read" {
  statement {
    sid = "Describe"
    actions = [
      "lightsail:GetInstance",
      "lightsail:GetInstances",
      "lightsail:GetStaticIp",
      "lightsail:GetStaticIps",
      "lightsail:GetInstancePortStates",
      "lightsail:GetRegions",
      "route53:GetHostedZone",
      "route53:ListHostedZones",
      "route53:ListHostedZonesByName",
      "route53:ListResourceRecordSets",
      "route53:ListTagsForResource",
      "route53:GetChange",
      "acm:DescribeCertificate",
      "acm:ListCertificates",
      "acm:ListTagsForCertificate",
      "cloudfront:GetDistribution",
      "cloudfront:GetOriginAccessControl",
      "cloudfront:GetResponseHeadersPolicy",
      "cloudfront:GetCachePolicy",
      "cloudfront:ListCachePolicies",
      "cloudfront:ListTagsForResource",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "State"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${local.state_bucket}", "arn:aws:s3:::${local.state_bucket}/prod/*"]
  }
  statement {
    sid       = "WebBucket"
    actions   = ["s3:GetBucket*", "s3:GetAccelerateConfiguration", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:GetEncryptionConfiguration", "s3:ListBucket"]
    resources = [local.prod.web_bucket_arn]
  }
}

data "aws_iam_policy_document" "deploy" {
  # the state and its lock
  statement {
    sid       = "StateWrite"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${local.state_bucket}/prod/*"]
  }
  # the relay: only resources tagged as parawatch's (the account has other Lightsail instances)
  statement {
    sid = "Relay"
    actions = [
      "lightsail:TagResource",
      "lightsail:UntagResource",
      "lightsail:EnableAddOn",
      "lightsail:DisableAddOn",
      "lightsail:PutInstancePublicPorts",
      "lightsail:OpenInstancePublicPorts",
      "lightsail:CloseInstancePublicPorts",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = ["parawatch"]
    }
  }
  # a short-lived SSH certificate for this one instance, to run deploy/relay/setup.sh
  statement {
    sid       = "RelayLogin"
    actions   = ["lightsail:GetInstanceAccessDetails"]
    resources = [local.prod.instance_arn]
  }
  statement {
    sid       = "Dns"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${local.prod.zone_id}"]
  }
  statement {
    sid       = "Web"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject", "s3:PutBucket*", "s3:PutEncryptionConfiguration", "s3:PutLifecycleConfiguration"]
    resources = [local.prod.web_bucket_arn, "${local.prod.web_bucket_arn}/*"]
  }
  statement {
    sid       = "Cdn"
    actions   = ["cloudfront:UpdateDistribution", "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation", "cloudfront:TagResource", "cloudfront:UntagResource"]
    resources = [local.prod.web_distribution_arn]
  }
}

resource "aws_iam_role" "plan" {
  name                 = "gha-penspanic-parawatch-plan"
  description          = "GitHub Actions, penspanic/parawatch, environment plan: read the prod infrastructure"
  assume_role_policy   = data.aws_iam_policy_document.trust["plan"].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "plan" {
  name   = "read"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.read.json
}

resource "aws_iam_role" "deploy" {
  name                 = "gha-penspanic-parawatch-deploy"
  description          = "GitHub Actions, penspanic/parawatch, environment production: apply prod and deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust["deploy"].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "deploy_read" {
  name   = "read"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.read.json
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "plan_role_arn" {
  value = aws_iam_role.plan.arn
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "account_id" {
  value = data.aws_caller_identity.me.account_id
}
