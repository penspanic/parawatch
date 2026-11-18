#!/usr/bin/env bash
# Makes the S3 bucket that holds the Terraform state, once per AWS account. Safe to run again.
#
#   AWS_PROFILE=... bash infra/terraform/bootstrap-state.sh
#
# The bucket is private, versioned (an older state can be brought back) and encrypted. Locking uses
# a lock file in the same bucket (`use_lockfile`), so no DynamoDB table is needed.
set -euo pipefail

BUCKET="${BUCKET:-parawatch-tfstate-penspanic}"
REGION="${REGION:-ap-northeast-2}"
aws() { command aws --region "$REGION" "$@"; }

if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "$BUCKET exists"
else
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  echo "made $BUCKET"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
echo "ready: versioned, encrypted, no public access"
