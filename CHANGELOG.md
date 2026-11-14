# Changelog

## Unreleased

- A Codex session on another machine opens as a conversation too. The log and `codex` stay on that machine: its Parawatch app reads the session and writes the conversation to the shared folder, and a message typed here waits in the shared folder until that machine sends it to Codex and shows the answer, a few seconds later, as the sync tool moves the files. Both machines need this version, and the app has to be running on the machine with the session. Other machines can look at a session without asking; to send it messages, turn on "Messages from other machines" in the settings of the machine it runs on (off by default), since a message runs there without asking, as the session did. A message that takes more than two minutes to get there is not sent.
- Fix: on Windows, stopping a Codex answer left the conversation "working" for good, so it took no more messages. A stopped codex on Windows ends without writing that its turn ended; once the process is gone, the turn now counts as over and the conversation shows that it was stopped.
- The app finds `codex` where the Codex installer for Windows puts it.

## 0.3.15 (2026-11-14)

- Fix: a session running on another machine could not be opened from this one, and on Windows no Claude app session could be opened at all. Parawatch only looked for the Claude app's sessions in the folder of the installer build, while the Microsoft Store build keeps them elsewhere; it now looks in both. When a session has Remote Control on, parawatch passes its link to the other machines, so clicking it there opens it on claude.ai. A subagent opens the session it works under. A session on another machine without Remote Control is no longer shown as a link, and its tooltip names the machine it runs on. The machine running the session needs this version to pass the link on.
- On Windows, `goto` opens links through the system handler, so a link with `&` in it is no longer cut short.
- The app opens Codex sessions and `codex exec` jobs as conversations. Click one on this machine to read what was asked, what Codex answered, the commands it ran (with their output) and the files it changed (with the diff), as Codex writes them. Type below to send it the next message: it runs `codex exec resume` with the sandbox, extra folders and model the session last had, and never waits for an approval, as an `exec` run cannot ask. While Codex answers, the pane shows what it is doing, with a button to stop it. A session that is open in the Codex app or a terminal, or that Codex is already working on, takes no message until it is free. Set `PARAWATCH_CODEX_BIN` when the app cannot find `codex`.

## 0.3.14 (2026-11-13)

- Fix: the app could update twice in a row. Once an update was downloaded, it stopped looking, so a release that came out later was only found after the restart. It now keeps looking while an update is ready, and looks once more right before Restart to Update; when something newer is out, it downloads that and then restarts into it.
- Fix: when two sessions claimed `--role lead` in the same project within the same millisecond, the earlier one stayed lead. The later claim now wins.
- The app has a board: every project at a glance, one line per session, marked as needing you, stopped, running, waiting on others, or quiet, with the cards and pull requests it is stopped on as chips. A button in the title bar switches between the board and the feed (the cards and the agents' chart); from about 1000 pixels wide both show side by side. The summary at the top filters the board, and a card chip goes to the card in the feed.
- On macOS the title bar takes a second line when a narrow window has many counts, instead of spilling over.
- Tests for the command line, the panel and the updater. Windows CI failures now fail the build.

## 0.3.13 (2026-11-13)

- Fix: a session's first wait read the log from the top. A new lead was then woken by every old change on the project's pull requests, also ones merged weeks before (CI results, conflicts). A first wait now starts just before the session first shows in the log: its claim, a card it opened, a pull request linked or handed to it.

## 0.3.12 (2026-11-13)

- Fix: a lead waiting with `wait -p <project>` was woken by every answer and every pull request change in the project, also on cards and pull requests another live session owned and was waiting on itself, and spent a turn each time to say it was not its own. Inside a session, `-p` now only names the project: what another live session owns goes to that session. Outside a session, `-p` still reads everything. A lead that moves to the new rule starts where its project wait stopped.
- Fix: once a session ended with `claim --done`, news on its pull requests that were already merged or closed (bot comments after a merge) woke every session waiting in the project. That news now wakes only the session that owned the pull request; open cards and open pull requests still pass to the project's sessions.
- What no session owns in a project, and what a session that has ended left open, now goes to the project's lead only, instead of waking every session there. A lead is the session that last claimed `--role lead`; one per project.
- With no lead, such answers and pull requests wait in parawatch instead of being lost or waking everyone: `status` lists them under NO SESSION GETS THESE, a card says no session gets its answer yet, and the panel shows them in their own group with a Help button that lists the project's sessions and makes one the lead. The new lead is handed what was waiting and told once of each.
- `parawatch lead <project> <session>` picks a lead from the command line. `parawatch hand <card or PR> <session>` gives a card or a pull request to another session, which is told once, with the card's answer.
- The skill, docs/agents.md and the instruction block say a lead waits with a plain `parawatch wait`, that a session the human started on their own keeps its cards, and what a handed card looks like.

## 0.3.11 (2026-11-13)

- Fix ([#28](https://github.com/penspanic/parawatch/issues/28)): on Windows, `wait` could exit with `EPERM` while Syncthing or a cloud drive replaced another machine's event log, and an agent that did not notice stopped being woken. A log that cannot be opened for a moment is tried again a few times and then read as it was last time; `wait` keeps polling through such errors, and through errors from watching the folder.
- Fix: a subagent that ran `parawatch claim` renamed the session that started it, because a subagent runs with its session's id. The claim now goes to the subagent whose log is running the command, so the lead keeps its own title and task.
- A card's file that is not on this machine yet (a cloud drive or sync tool still bringing it, or a path only the asking machine has) shows as "not on this machine yet" with a dashed outline, instead of failing to open with no reason.

## 0.3.10 (2026-11-12)

- Fix: an app opened from Finder could not find `gh` (Homebrew's folder is not on its `PATH`), and its failed readings counted as fresh, so no process read GitHub and pull request news stopped for every agent. Each process now looks for `gh` in the usual install folders too (or `github.cli` in config.json), a failed reading leaves the last good one in place so a process whose `gh` works reads at once, and while nobody gets through the app shows "GitHub is not being read", `status` says so, and `doctor` names the process that failed and why.
- Fix: a subagent that handed its report back, or that Claude Code marks finished in its meta file, showed as stalled while thinking. It is done.
- Fix: on a card with options, an answer with words but no choice moved the card to answered, and it stayed there after the agent replied and asked for the choice. Once the agent comments, the card is back in what needs you, with the exchange shown on the card, until you choose.
- Fix: a question asked at the end of a turn stayed under asked in chat after the human replied, when the reply was a pasted block or other text the log marks as the human's but not as a typed prompt.
- Fix: a session that searched for the words `gh pr create` (in `grep`, a quoted message, a heredoc) was taken to have opened a pull request, and got any pull request URL in the output, taking it from the session that did open it. Only a command that runs `gh pr create` counts, only the URL it prints on its own line is taken, and such a wrong link gives way to the session that opened the pull request. A link made with `parawatch pr link` stays.
- A session held by a permission prompt shows under needs you as "approve a tool call: <tool>" when the Claude Code hook also handles `PermissionRequest` and `Notification` (see docs/agents.md). Without them, a session stalled on a tool call says a permission prompt may be open.

## 0.3.9 (2026-11-11)

- The desktop app is built on GitHub's machines from a version tag, for macOS and now Windows: an x64 installer (`Parawatch-Setup-<version>.exe`) that updates itself like the macOS app. It is not signed yet, so Windows warns the first time it is opened. A pull request that touches the app builds both, to see the build still works.
- On Windows the app installs for the current user into `%LOCALAPPDATA%\Programs\parawatch`, with a Start menu entry whose app id lets its notifications through.

## 0.3.8 (2026-11-11)

- A card's pictures open in a viewer over the app window instead of another app: the page dims, the picture fits the window, and it zooms with the wheel, a trackpad pinch, a double click or + and - (0 fits), and pans by dragging. The arrows (or ← →) go to the card's other pictures and videos; Esc or a click beside the picture closes it. A video plays in its card as before and has a button at its top right to view it larger. "Open in its own app" stays in the viewer's bar.
- The dismiss button sits in the card's head, beside the fold button, instead of on its corner. It shows while the card is hovered; the first click turns it into a red "Dismiss" in place of the age and id, and a second click within three seconds dismisses.
- The app's settings show the command line's version under the app's, and update it when it is older, with the npm that installed it. With Update the command line too on (the default), an app that has just updated itself brings the command line to its version a little after it starts, so one restart updates both.
- An approved pull request with green CI that GitHub still reports as blocked shows as `merge held` instead of `merge`, and counts as stuck after 8 hours. Something other than reviews and CI holds it: a branch rule, or a merge system outside GitHub with its own approvers. GitHub does not say who.
- A session's pull requests show on its lane in the agents chart, after its cards: `#22 review`, `#23 CI failed`, `#21 held`, in red once stuck. A click goes to the pull request in its section; a right click opens a menu with Open Link and Copy Link, as does the pull request's name in its section. An idle session with nothing else pending says which pull request it waits on and on what, instead of its last summary.
- A click that scrolls to a card or a pull request (a card or pull request chip on a lane) marks where it went: once the scroll stops, a ring pulses twice around the card or row and fades.
- In `status`, a run whose title is cut keeps its `(N PR)` count and repeat count at the end.
- A card's head stays on one line: when it is narrow, who asked is cut short (the whole name is in the tooltip).

## 0.3.7 (2026-11-10)

- Dismiss a card that no longer matters: the round x on the card's corner in the app (click twice), or `parawatch dismiss <card> -n "why"`. The card closes without an answer and shows as dismissed under Closed. The agent that asked gets "dismissed by the human" at its next `wait` or `inbox`.
- Card sections are a colored tile and a count, with what they are in the tooltip. What needs you is in color (a project's cards, asked in chat, reviews); below an hourglass rule, what waits on others is gray (pull requests, answered, closed). Nothing needs you is a green check.
- The counts at the top are chips in their section's color, and a click opens the section and scrolls to it.
- In the agents chart each project has a tinted head row and a rule above it, and the head row's timeline sums all the project's runs, so a folded project still shows when it was busy.

## 0.3.6 (2026-11-10)

- Fix: a Claude Code turn the human stopped showed as working and then stalled, and so did the subagents stopped with it. A stopped session now shows as idle and a stopped subagent as done, both marked "interrupted".

## 0.3.5 (2026-11-10)

- Publishing a GitHub release publishes the CLI to npm from GitHub Actions, with npm trusted publishing and a provenance statement.
- The app shows each card's id in its head (`c58`, or `winpc-c11` for a card from another machine), as agents name it in chat. A click copies it.
- A card folds to its title with the chevron in its head, and stays folded until you open it again.
- The to-do group inside a project opens as a box inside the project. Answered cards are a group of their own, and the to-do, answered and closed groups are named.
- A run that opened a card and has no answer yet shows the card at the end of its timeline, and its line says what it waits on. A click goes to the card.
- The color for a session that asked in chat is a darker mustard that reads as text, and red text has more contrast.

## 0.3.4 (2026-11-10)

- A Claude Code run that ended its turn while a background job it started is still running shows as working, with the job's command, instead of done or idle. It counts as stalled only when both its log and the job's output file have been quiet for 20 minutes, so a job that hung shows up instead of dropping out of the list. A `parawatch wait` or `parawatch watch` in the background does not count: that session is waiting for the human.
- A lead that has really ended (it said `claim --done`, or it was archived in the Claude desktop app) leaves the list 30 minutes after its last activity, like other runs. An idle lead still stays.
- Hide a run: the eye button on a run row in the app, or `parawatch run hide <id>`. It stays hidden on every machine until it does something new. `parawatch run unhide <id>` brings it back, and `runs --all` shows hidden runs.
- Approval cards: the preview is folded to a few lines with Show all, a Markdown preview renders without its frontmatter, and a chip opens the preview file itself. The action shows its first line, with the whole text under details.
- `parawatch edit` can change `--action`, `--preview` and `--attach` (`--no-attach` clears) while nobody has answered the card. The card shows when the action or preview changed. After an answer, open a new card instead.
- The desktop app shows each service's own icon (Claude Code, Codex, GitHub) beside runs, pull requests and the card's asker. The icon is fetched from the service's site, as a browser shows it, and cached for a week; no logo files ship with parawatch. Turn it off in Settings with "Show service icons".

## 0.3.3 (2026-11-10)

- Folders are compared by their real spelling: symlinks and Windows short names are resolved, and on Windows case and `/` against `\` no longer matter. A run in a worktree reached through a link, or on Windows, finds its project, and so does the Claude Code hook.
- The test suite passes on Windows.
- A Claude Code session archived in the Claude desktop app shows as done, with its subagents. One archived in the middle of a turn used to show as stalled for hours.
- Cards and pull requests of a session that has ended (it said `claim --done`, or it was archived in the Claude desktop app) belong to its project again: an answer reaches the other sessions waiting in that project, as for a card no session owns. Before, it reached only a wait on the whole project (`wait -p`). The card in `status` and the app counts those waits.
- `claim --done` also ends a session that shows as stalled, not only an idle one.
- `runs` and `status` show the machine a run is on in a column of its own. It used to follow the title and was cut off with it at most terminal widths.
- The settings screen has a Back control with a chevron at the leading edge of its header instead of a close button on the right. Esc still goes back.
- Restart to Update now says "Installing 0.x.y. Parawatch reopens in about 30 seconds." before it quits, because the install takes about half a minute with nothing on screen. Opening Parawatch again during that time used to make the update fail; it now tells you the install is still going and closes itself so the update can finish.
- If an update was downloaded but the restart never finished, Parawatch says so the next time it starts and offers Restart to Update again, in settings and in the menus.
- Fix: a path to open or attach that is absolute on the other system was rooted on this one: `/Users/Shared/...` became `E:\Users\Shared\...` on Windows, and `C:\...` became `<folder>/C:\...` on a Mac. A path absolute on either system is now kept as written, so a card opened on the PC can name an app on the Mac. In Git Bash, use `MSYS_NO_PATHCONV=1`.

## 0.3.2 (2026-11-10)

- `wait` and `inbox` run from an agent session read only that session's news: answers on cards it opened, news on pull requests linked to it, and cards or pull requests no session owns in the project it claimed. Each session reads with a cursor of its own, so sessions in one project no longer wake for each other's pull requests or take each other's news. A session that used to wait with `-p` starts where that wait stopped.
- `wait -p <project>` still reads the whole project, for a lead. Outside an agent session nothing changes.
- The instruction block (`parawatch init`) and the skill now say `parawatch wait`. `doctor` reports an older block as outdated; run `parawatch init` again to update it.
- The Claude Code hook reports only the session's own unhandled news.
- Fix: a machine reading GitHub for the first time in a while wrote again the pull request news another machine had already reported, and every wait woke a second time. News another machine wrote since this machine last read GitHub is now left out.
- Runs on another machine show in `runs`, `status` and the app, marked with the machine. Each machine writes a summary of its sessions to `runs/<device>.json` in the shared folder about every half minute while `status`, a `wait` or the app runs; the agent logs stay where they are. A summary older than 15 minutes is left out. Claims made on any machine apply to those runs.

## 0.3.1 (2026-11-10)

- Fix: Restart to Update only hid the window and the app kept running, so the update waited until the next Quit. Updating from 0.3.0 still needs that one Quit; later versions restart on their own.

## 0.3.0 (2026-11-10)

More than one machine.

- `parawatch sync setup <folder> --device <name> [--adapter syncthing|folder]` shares cards and answers with your other machines through a folder something else keeps in step. Each machine writes only `events/<device>.jsonl`; every machine reads them all, in time order. This machine's log moves there whole, so ids, cursors and open cards carry on.
- A machine that does not share keeps the single `events.jsonl` in format 1, exactly as before.
- Shared ids carry the machine (`pc-c3`); the short form works while it is unique.
- Two machines answering one card at once: the earlier answer stands, the other is kept on the card as not used and wakes nobody.
- Paths written on another machine are read as the same place here (its home, the shared folder, and folders named with `parawatch sync root`). Pasted pictures go to the shared folder.
- Waits running on any machine show on cards. The same GitHub news read by two machines is delivered once.
- Sync adapters report how the sync tool is doing: `syncthing` (its REST API) and `folder`. `parawatch sync`, `doctor` and the app's settings show the other machines, the last time the folder was in step and conflict copies.
- The panel shows which machine a card or an answer came from.

## 0.2.1 (2026-11-09)

Versions, updates and housekeeping.

- The desktop app updates itself from GitHub Releases: it checks a little after start and every few hours, downloads in the background, and offers Restart to Update (also in the menu bar menu). Settings has Update automatically. Coming from 0.2.0, download this version once by hand.
- The app has its own macOS menus: About Parawatch with the version, Check for Updates, Settings (⌘,), and Help with What's New, Report an Issue (versions filled in), Show Log File and Show Data Folder. The Electron defaults that led to electronjs.org are gone.
- Settings shows the app's version, where its update stands, and the CLI version beside it, with a warning when they differ.
- The app keeps a log in `~/Library/Logs/Parawatch/main.log`: start-up, errors it survived, update checks.
- `parawatch doctor [--json] [--offline]`: versions, store, desktop app, skill links, instruction files, hook, GitHub, with what to run for each problem.
- `status` ends with a line when a newer CLI is out (the npm registry, at most once a day; `PARAWATCH_UPDATE_CHECK=0` or `"updates": { "check": false }` turns it off) or when the app and the CLI are different versions.
- `parawatch skill uninstall` and `parawatch init --remove`, and the README says how to remove the rest.
- A copy refuses to write to a log a newer copy wrote, instead of mixing formats.
- The CLI reads its version from package.json.
- Fix: the 0.1.0 and 0.2.0 app packages carried the panel's test files, among them a saved board snapshot. 0.1.0's held real cards from the machine that built it, so that release has been withdrawn. The app package now holds only the app, and the release script checks it.

## 0.2.0 (2026-11-09)

From running parawatch on a work machine where every session starts in one notes folder and most waiting is on pull requests.

- Claims carry the work: `claim -t <ticket or PR>` as soon as the work is clear, `claim` again when it changes, `claim --done "<summary>"` when it is finished, `claim --kind scheduled` for sessions a schedule starts. `-p` may be left out once a session has claimed. The agent skill and `init` say so.
- A session that only edits another project's files is grouped with that project, not with the folder it started in. `--wide` marks such guesses.
- Pull requests through `gh` (GitHub and GitHub Enterprise): `pr link`, `pr list`, `pr sync`, `pr event`. `status` gets WAITING ON OTHERS and REVIEWS ASKED OF YOU, with what each pull request waits on, since when, and stuck ones in red. News on a linked pull request wakes the owning project's `wait`. A pull request a session opened with `gh pr create` is linked from its log.
- `goto` takes a pull request (URL, `owner/repo#N`, `repo#N`) and opens the session that owns it.
- ASKED IN CHAT: a session whose turn ended with a question and no card, read from the Claude desktop app's end-of-turn summary or the last message.
- Approvals: `ask --action "<command>" [--preview <file>]` shows the exact step and the text it sends, with Do it and Don't.
- Waits are visible: an answered card says whether an agent is waiting for it.
- Repeated runs of a scheduled task fold into one row (`runs --every` lists them all).
- Heartbeats for declared jobs: `run start --heartbeat <seconds> [--log <file>]`, `run beat`. A job past its heartbeat shows as stalled.
- `digest [--date] [--json]`: what each session did on a day.
- Desktop app: the new sections in the panel, GitHub read on an interval, notifications for pull requests that stop landing and for jobs that stop beating.

## 0.1.0 (2026-11-09)

First release.

- Cards: `ask`, `try`, `block` and `todo`, answered from the CLI or the desktop app. `wait` wakes the agent that asked when you answer.
- Observed runs: Claude Code sessions with their subagents, and Codex sessions and `codex exec` jobs, grouped by project. Declared runs for jobs that leave no log.
- `status` and `runs` print one line per item within the terminal width. `status --json` and `watch` for anything that wants to build on top.
- Agent skill and `parawatch init` for a project's instruction file. A Claude Code hook as a backstop for missed answers.
- Desktop app: the panel in its own window, an agents chart, a menu bar count, a Dock badge, notifications, settings, and answered and closed cards you can open again with their builds, videos and pictures.
