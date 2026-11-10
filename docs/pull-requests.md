# Pull requests

When the [GitHub CLI](https://cli.github.com) is installed and signed in, parawatch reads your open pull requests and the ones asking for your review, on every host `gh` knows (GitHub Enterprise included). It never holds a token of its own. Without `gh`, all of this stays off.

- **Whose it is.** A session links a pull request with `parawatch pr link <url>`. One it opened with `gh pr create` is linked from its log on its own.
- **What it waits on.** Review (and from whom), CI, a failed check, requested changes, a conflict, the merge queue, auto-merge, or the merge itself, and since when. Past a limit per state it shows as stuck.
- **News wakes the owner.** New reviews, approvals, requested changes, comments, CI results, conflicts, leaving the merge queue without merging, and the merge arrive at the owning project's `wait` like an answer. The desktop app notifies what keeps a pull request from landing, and the landing.
- **Other sources.** A merge bot or a ticket system can record news the same way: `parawatch pr event <url> queue_removed -m "batch 412 failed"`.

GitHub is read when its last reading is older than the interval: by `status`, by a running `wait`, and by the desktop app. `parawatch pr sync` reads it now. Pull requests nobody touched for 60 days are left out unless a session owns them.

`config.json` in the store folder changes the defaults (every key is optional):

```json
{
  "github": {
    "enabled": true,
    "intervalMinutes": 5,
    "maxAgeDays": 60,
    "stallHours": { "review": 24, "CI": 2, "merge queue": 6, "conflict": 4 }
  }
}
```

`PARAWATCH_GITHUB=0` turns it off for one command.
