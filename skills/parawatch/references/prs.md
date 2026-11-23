# Pull requests

`parawatch guide prs` prints this page for the installed version.

When you open a pull request, link it to yourself:

```
parawatch pr link <url>          # or #88 inside the repository
```

A pull request you open with `gh pr create` is linked from your log on its own, but say it anyway; it costs nothing and survives a long session. When `gh` is installed and signed in, parawatch reads your pull requests from GitHub (GitHub Enterprise too). New reviews, requested changes, approvals, CI failures, conflicts, a drop from the merge queue and the merge itself arrive at your wait like an answer. The human sees the PR, what it waits on and for how long, next to your session.

News from somewhere GitHub does not show (a merge bot, a ticket system) can be recorded by any tool: `parawatch pr event <url> <change> -m "<what happened>"`.

- **Taking over a pull request another session opened** (its session ended, and you continue the work): run `parawatch pr link <url>` when you start. The latest link wins, so its news comes to you from then on instead of to the lead.
- **A pull request set aside on purpose** (a draft parked until later): `parawatch pr unlink <url>`. Its news then wakes no one, not even the session that opened it, until someone links it again. A conflict on a PR that stays in conflict is reported once, not again each time main moves.
