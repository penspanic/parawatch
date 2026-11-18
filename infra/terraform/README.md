# Infrastructure

The relay and the phone web app, as Terraform. A change here goes through a pull request like any other; the owner applies it.

| | |
|--|--|
| `modules/relay` | One relay on Amazon Lightsail: the instance, a static IP, the open ports, daily snapshots, and the DNS names in Route 53. What runs inside the instance is set up by [`deploy/relay/setup.sh`](../../deploy/relay/setup.sh). |
| `envs/prod` | The one at `relay.parawatch.penspanic.com` and `parawatch.penspanic.com`. Its state is in S3. |
| `bootstrap-state.sh` | Makes the S3 bucket for the state, once per account. |

## Changing it

1. Edit the module or the environment. Run `terraform fmt -recursive infra/terraform`.
2. Check it without touching anything: `terraform -chdir=infra/terraform/envs/prod init -backend=false && terraform -chdir=infra/terraform/envs/prod validate`. CI runs the same on every pull request.
3. To try it for real, run it in your own AWS account: copy `envs/prod` to a folder of your own, change the names, the domain and the backend bucket, and apply there. Say in the pull request what the plan showed.
4. Open a pull request. The owner reviews it, merges it and applies it.

Nobody but the owner applies `envs/prod`. Pull requests from forks never get AWS credentials.

## First apply (owner, once)

```sh
AWS_PROFILE=personal bash infra/terraform/bootstrap-state.sh
AWS_PROFILE=personal terraform -chdir=infra/terraform/envs/prod init
AWS_PROFILE=personal terraform -chdir=infra/terraform/envs/prod plan
AWS_PROFILE=personal terraform -chdir=infra/terraform/envs/prod apply
```

The resources made before this code existed are taken in by `envs/prod/imports.tf`; the first apply records them and changes nothing on them except what the plan shows. After it, the import blocks can be removed.
