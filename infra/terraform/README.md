# Infrastructure

The relay and the phone web app, as Terraform. A change here goes through a pull request like any other; the owner approves each deploy.

| | |
|--|--|
| `modules/relay` | One relay on Amazon Lightsail: the instance, a static IP, the open ports, daily snapshots, and its DNS name in Route 53. What runs inside the instance is set up by [`deploy/relay/setup.sh`](../../deploy/relay/setup.sh). |
| `modules/web` | The phone web app as static files: a private S3 bucket behind CloudFront, its certificate and DNS name. |
| `envs/prod` | `relay.parawatch.penspanic.com` and `parawatch.penspanic.com`. Its state is in S3. The Deploy workflow applies it. |
| `envs/ci` | The two AWS roles the Deploy workflow takes. Only the owner applies it, from their own machine. |
| `bootstrap-state.sh` | Makes the S3 bucket for the state, once per account. |

## Changing it

1. Edit the module or the environment. Run `terraform fmt -recursive infra/terraform`.
2. Check it without touching anything: `terraform -chdir=infra/terraform/envs/prod init -backend=false && terraform -chdir=infra/terraform/envs/prod validate`. CI runs the same on every pull request.
3. To try it for real, run it in your own AWS account: copy `envs/prod` to a folder of your own, change the names, the domain and the backend bucket, and apply there. Say in the pull request what the plan showed.
4. Open a pull request. The owner reviews it and merges it.

## Deploying

[`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) runs once a release is on npm:

1. **plan** (GitHub environment `plan`, read-only role): the Terraform plan for `envs/prod`, in the run's summary.
2. **deploy** (GitHub environment `production`): waits for the owner to approve on the run's page. Then it plans again and stops if anything differs from what was approved, applies, runs `deploy/relay/setup.sh` on the relay server at the release's version (with a Lightsail SSH certificate that lives for minutes, checking the server's host keys from Lightsail), uploads the web app to S3, clears CloudFront's copy, and checks that the relay and the new web app answer.

After a change to `infra/` or `deploy/` alone, run the workflow by hand from main ("Run workflow"); tick "web" to also upload the web app built from main.

Pull requests from forks never get AWS credentials: the roles trust only jobs of `penspanic/parawatch` running in those two environments, and `production` waits for the owner.

## Setting it up (owner, once)

The state bucket, the first apply and the roles change the AWS account; run them from your own machine with an admin profile.

```sh
export AWS_PROFILE=personal
bash infra/terraform/bootstrap-state.sh
terraform -chdir=infra/terraform/envs/prod init
terraform -chdir=infra/terraform/envs/prod apply
terraform -chdir=infra/terraform/envs/ci init
terraform -chdir=infra/terraform/envs/ci apply
```

Then the GitHub environments, each with the role it takes (`terraform -chdir=infra/terraform/envs/ci output`):

```sh
gh api -X PUT repos/penspanic/parawatch/environments/plan \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/penspanic/parawatch/environments/plan/deployment-branch-policies -f name=main -f type=branch
gh variable set AWS_ROLE_ARN --env plan --body "<plan_role_arn>"

gh api -X PUT repos/penspanic/parawatch/environments/production --input - <<'JSON'
{"reviewers":[{"type":"User","id":<your GitHub user id>}],"prevent_self_review":false,
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api -X POST repos/penspanic/parawatch/environments/production/deployment-branch-policies -f name=main -f type=branch
gh variable set AWS_ROLE_ARN --env production --body "<deploy_role_arn>"
```

The roles trust the subject GitHub sends for this repository, which names it by ids (`repo:penspanic@13113921/parawatch@1449403714:environment:...`; see `gh api repos/penspanic/parawatch/actions/oidc/customization/sub`).

Main is protected: changes go through pull requests that pass CI, and the ones touching `.github/CODEOWNERS` paths wait for the owner's review. The owner's own pull requests are merged with `gh pr merge --admin` once every check has finished.

Both workflows run from main (a release's deploy is started by the npm publish, which runs the workflow file on main), so main is the only branch the environments allow.

### Moving the web app off the relay server (2026-11, once)

Until 0.3.27 the relay server's Caddy served the web app. The move keeps the name answering throughout:

1. Make the bucket and the distribution without touching DNS, and upload the app. Terraform refuses `-target` while a `moved` block is pending, so move the record's address in the state first (the record itself does not change):
   `terraform -chdir=infra/terraform/envs/prod state mv 'module.relay.aws_route53_record.app[0]' module.web.aws_route53_record.app`, then `terraform -chdir=infra/terraform/envs/prod apply -target=module.web.aws_cloudfront_distribution.web -target=module.web.aws_s3_bucket_policy.web`, then `node apps/web/build.mjs` and `aws s3 sync apps/web/dist s3://parawatch-web-penspanic --delete --cache-control no-cache`.
2. Check the app on the distribution's own name (`terraform output web_distribution_domain`).
3. `terraform apply` the rest: the name moves to CloudFront in one Route 53 change.
4. After the old record's five minutes are up, run `deploy/relay/setup.sh` on the server without `SERVE_WEB` (the Deploy workflow does), so Caddy stops serving the app and keeps only the relay and its CORS for the app.
