# Changelog

## Unreleased

- `wait` and `inbox` run from an agent session read only that session's news: answers on cards it opened, news on pull requests linked to it, and cards or pull requests no session owns in the project it claimed. Each session reads with a cursor of its own, so sessions in one project no longer wake for each other's pull requests or take each other's news. A session that used to wait with `-p` starts where that wait stopped.
- `wait -p <project>` still reads the whole project, for a lead. Outside an agent session nothing changes.
- The instruction block (`parawatch init`) and the skill now say `parawatch wait`. `doctor` reports an older block as outdated; run `parawatch init` again to update it.
- The Claude Code hook reports only the session's own unhandled news.
- Fix: a machine reading GitHub for the first time in a while wrote again the pull request news another machine had already reported, and every wait woke a second time. News another machine wrote since this machine last read GitHub is now left out.

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
