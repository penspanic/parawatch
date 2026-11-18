# Pull requests

When the [GitHub CLI](https://cli.github.com) is installed and signed in, parawatch reads your open pull requests and the ones asking for your review, on every host `gh` knows (GitHub Enterprise included). It never holds a token of its own. Without `gh`, all of this stays off.

- **Whose it is.** A session links a pull request with `parawatch pr link <url>`. One it opened with `gh pr create` is linked from its log on its own.
- **What it waits on.** Review (and from whom), CI, a failed check, requested changes, a conflict, the merge queue, auto-merge, or the merge itself, and since when. Past a limit per state it shows as stuck.
- **Held by something else.** An approved pull request with green CI that GitHub still will not merge (its `mergeStateStatus` is `BLOCKED`) shows as `merge held` instead of `merge`: a rule other than reviews and CI, or a merge system outside GitHub such as a merge bot with its own approvers, holds it. GitHub does not say who; look at the branch rules or the merge system's own page. It counts as stuck after 8 hours.
- **News wakes the owner.** New reviews, approvals, requested changes, comments, CI results, conflicts, leaving the merge queue without merging, and the merge arrive at the owning project's `wait` like an answer. The desktop app notifies what keeps a pull request from landing, and the landing, unless a session that is still running owns it: that session hears the news itself, and the human sees it on the session.
- **Other sources.** A merge bot or a ticket system can record news the same way: `parawatch pr event <url> queue_removed -m "batch 412 failed"`.

GitHub is read when its last reading is older than the interval: by `status`, by a running `wait`, and by the desktop app. `parawatch pr sync` reads it now. Pull requests nobody touched for 60 days are left out unless a session owns them.

## Issues assigned to you

The same reading asks for the open issues assigned to you, on every repository `gh` can see, touched in the last `maxAgeDays`. They are the human's, not an agent's: they wake no agent.

- **Where.** `status` lists them under ISSUES ASSIGNED TO YOU, and the app under "Assigned to you", next to the reviews asked of you, with a count in the header. Each shows who assigned it and when, the latest comment by someone else when there is a newer one, and the project when the repository is one a registered project's folders push to.
- **News.** The desktop app notifies once when an issue is assigned to you, and when someone else comments on one. Clicking the notification shows the issue's row in the window. Issues you assign to yourself, and the ones already assigned when parawatch first reads them, are not news.
- **Set aside.** The archive button on a row, or `parawatch issue aside <issue>`, folds an issue away. It comes back when someone else comments on it, or with `parawatch issue back <issue>`. An issue that is closed or no longer yours drops out on its own.

## From people

GitHub's own notifications are mostly the human's own account at work, because agents use it too: every comment and push an agent makes notifies the human as "author". The same reading asks GitHub for the unread notifications (one more call, plus at most 50 small ones to see who wrote a comment) and keeps the ones another person caused:

- someone asked for the human: a mention, a review or approval requested, an assignment, an invitation, a security alert;
- someone else commented on a thread the human is in, and the thread is not a pull request a session owns (its news goes to the session).

Left out: CI news, the account's own words, bots, and changes that carry no comment.

- **Where.** `status` lists them under FROM PEOPLE ON GITHUB, the app under "From people" at the top of the human's part, with a bell count in the header and on the board. `parawatch news` lists them with their keys.
- **Read.** Opening a row's link, its check button, or `parawatch news done <key>` marks the thread read here and on GitHub. A thread comes back when it has news after that.
- **News.** The desktop app notifies once per new thread or new word on one; the click shows the row.

## Recent

Everything that changed on pull requests and issues in the last day, newest first: merges, CI, reviews, assignments, with the session that owns each. A CI pass on a pull request that then merged is left out, and the same change read by two machines shows once. The app keeps it folded at the bottom ("Recent"); `parawatch news` prints it (`--hours` for more). A merged pull request leaves the list of open ones, so this is where a notification about it lands.

## Notifications

- **Where a click goes.** A notification opens the window at what it was about: the card, the pull request's row (or its line under "Recent" when it is no longer open), the issue, or the thread from a person. When the window does not show it, the page opens in the browser.
- **Fewer of them.** News read late (more than 30 minutes after the reading before it, as after the computer slept) is kept but not notified. Several at once (within a second and a half) are told as one ("5 updates on GitHub and jobs") that opens the recent news; cards always keep their own. The same thing told twice in one burst (an issue comment and the mention in it) is told once.

`config.json` in the store folder changes the defaults (every key is optional):

```json
{
  "github": {
    "enabled": true,
    "intervalMinutes": 5,
    "maxAgeDays": 60,
    "stallHours": { "review": 24, "CI": 2, "merge queue": 6, "merge held": 8, "conflict": 4 },
    "cli": "/opt/homebrew/bin/gh"
  }
}
```

`PARAWATCH_GITHUB=0` turns it off for one command.

Each process finds `gh` on its own `PATH`, or else in the usual install folders (Homebrew, `/usr/local/bin`, `GitHub CLI` under Program Files on Windows). An app opened from Finder does not get the shell's `PATH`; set `cli` when `gh` lives somewhere else. A reading that fails leaves the last good one in place, so another process whose `gh` works reads at once, and pull request news keeps coming. While no reader gets through, the app shows "GitHub is not being read" at the top, `status` says so at the end, and `doctor` names the process that failed and why.
