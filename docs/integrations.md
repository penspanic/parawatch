# Building on it

| | |
|--|--|
| [`apps/desktop`](../apps/desktop/README.md) | The desktop app. Reads and writes the store directly, so it works without the CLI on `PATH`. |
| [`packages/panel`](../packages/panel) | The panel both of them show, as plain DOM, with a harness page for working on it. |

The desktop app shows each service's own site icon beside runs and pull requests (Claude Code, Codex, GitHub). It fetches the icon from that service's site, like a browser's favicon, and caches it in the app's data folder for a week. Turn it off in Settings and nothing is fetched. The names and icons belong to their owners, and parawatch is not affiliated with them.

Anything else can build on the same two commands:

```
parawatch status --json          # one snapshot: projects, cards, runs, pull requests, running waits
parawatch watch                  # every new event as one JSON line
parawatch watch --from 120       # starting after event 120
```
