# Changelog

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
