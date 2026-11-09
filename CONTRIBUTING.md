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
| `skills/parawatch` | The agent skill |

## Checks

Run these before opening a pull request. CI runs the same on Linux and macOS.

```
npm run typecheck
npm test
(cd apps/desktop && npx vitest run)
npm run build
```

Try a CLI change without installing it with `npm run dev -- status`. Work on the panel in a browser with the harness in `packages/panel/harness`, which renders a fake snapshot. Run the desktop app from source with `npm start -w @parawatch/desktop`.

Use a scratch store while testing so your real cards stay out of it: `PARAWATCH_HOME=/tmp/pw-test parawatch ...`.

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
- **No server, and no network of our own.** Everything stays in the local store. The one thing read from outside is pull requests, through the user's own `gh`, and only when it is installed and signed in. Agent logs and cards are never sent anywhere.
- **Test data is made up.** No real project names, paths or card text from your own machine.
- Keep the store format backward compatible. A new event type is fine; changing what an old one means is not.

## Pull requests

One change per pull request, with a short description of what it does and how you checked it. A screenshot helps for anything in the panel.
