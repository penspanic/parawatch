# Contributing

Thanks for looking. parawatch is small on purpose, so the bar for new features is "does it help one person keep track of many agents". Bug fixes, new runtime adapters and platform fixes are the most welcome.

## Setup

```
git clone https://github.com/penspanic/parawatch.git
cd parawatch
npm install
```

Node 20 or newer. The repository is an npm workspace:

| | |
|--|--|
| `src/` | The CLI and the store (`parawatch` on npm) |
| `packages/panel` | The panel the app and the plugin share, as plain DOM |
| `apps/desktop` | The Electron app |
| `apps/web` | The phone web app |
| `skills/parawatch` | The agent skill |
| `infra/terraform`, `deploy/relay` | The project's relay and web app on AWS |

## Checks

Run these before opening a pull request. CI runs the same on Linux, macOS and Windows.

```
npm run typecheck
npm test
(cd apps/desktop && npx vitest run)
npm run build
```

Try a CLI change without installing it with `npm run dev -- status`. Work on the panel in a browser with the harness in `packages/panel/harness`, which renders a fake snapshot. Run the desktop app from source with `npm start -w @parawatch/desktop`.

Use a scratch store while testing so your real cards stay out of it: `PARAWATCH_HOME=/tmp/pw-test parawatch ...`.

Nothing here needs an AWS account or the project's servers. To try the phone app with a relay of your own, run one locally (`parawatch relay serve --port 8787`, see [Relay](docs/relay.md)) and build the web app (`npm run build -w @parawatch/web`).

For a whole made-up board (projects, cards with pictures, an hour of fake Claude Code and Codex activity), run the demo script. It prints the variables that point the CLI and the app at it. The screenshots in the README come from it.

```
npm run demo -- /tmp/pw-demo > /tmp/pw-demo.env
source /tmp/pw-demo.env
npm run dev -- status
npm start -w @parawatch/desktop
```

## Rules

- **English everywhere.** Code, comments, commit messages, docs, test data.
- **Read only from agent logs.** An adapter never writes to another tool's files and never sends them anywhere.
- **Local first.** Everything works from the local store with no network of ours. What is read from outside: GitHub, through the user's own `gh` and only when it is installed and signed in, and the latest version (the npm registry for the CLI, GitHub Releases for the app), which the user can turn off. The relay is optional: it carries only what machines sealed with a key it never sees ([Relay](docs/relay.md)). Agent logs and cards are never sent anywhere in the clear, and nothing is sent about the user.
- **A release holds only the app.** The desktop build bundles everything into `dist/`; `scripts/check-package.cjs` fails a release that carries anything else or names the building machine's home folder.
- **Test data is made up.** No real project names, paths or card text from your own machine.
- Keep the store format backward compatible. A new event type is fine; changing what an old one means is not.

## Pull requests

Fork the repository and open the pull request from your fork; nobody needs write access. One change per pull request, with a short description of what it does and how you checked it. A screenshot helps for anything in the panel.

What happens to it:

1. CI runs the checks above on three systems, checks the Terraform code, and builds the desktop app without signing. The builds are on the run's page, so the owner (and you) can try them.
2. The owner reviews it. Changes to `infra/`, `deploy/` and `.github/` always wait for the owner (`.github/CODEOWNERS`).
3. The owner merges it. A pull request from a fork never gets credentials: no AWS, no signing, no npm.
4. On the next release the Deploy workflow plans the infrastructure, waits for the owner's approval, then applies it and updates the relay and the web app ([infra/terraform](infra/terraform/README.md)).

## Changing the infrastructure

The project's relay and phone web app are Terraform in `infra/terraform` and a setup script in `deploy/relay`. Change them in the same pull request as the code that needs them:

- Run `terraform fmt -recursive infra/terraform` and `terraform -chdir=infra/terraform/envs/prod init -backend=false && terraform -chdir=infra/terraform/envs/prod validate`.
- To try it for real, apply a copy of `envs/prod` with your own names, domain and state bucket in your own AWS account, and say in the pull request what the plan showed.
- Never put secrets, account ids or keys in the code. The relay's invite lives only on its server.
