# Changelog

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
