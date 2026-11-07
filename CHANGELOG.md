# Changelog

## 0.1.0 (unreleased)

First release.

- Cards: `ask`, `try`, `block` and `todo`, answered from the CLI or the desktop app. `wait` wakes the agent that asked when you answer.
- Observed runs: Claude Code sessions with their subagents, and Codex sessions and `codex exec` jobs, grouped by project. Declared runs for jobs that leave no log.
- `status` and `runs` print one line per item within the terminal width. `status --json` and `watch` for anything that wants to build on top.
- Agent skill and `parawatch init` for a project's instruction file. A Claude Code hook as a backstop for missed answers.
- Desktop app: the panel in its own window, an agents chart, a menu bar count, a Dock badge, notifications, settings, and answered and closed cards you can open again with their builds, videos and pictures.
