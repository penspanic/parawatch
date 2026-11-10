# Observed agents

parawatch reads agent logs. It never writes to them and never sends them anywhere.

| Runtime | Where it reads | What it shows |
|--|--|--|
| Claude Code | `~/.claude/projects/*/<session>.jsonl` and `<session>/subagents/` (or `$CLAUDE_CONFIG_DIR`) | sessions with their title, subagents with their description and model, the tool in flight |
| Codex | `~/.codex/sessions/` (or `$CODEX_HOME`) | `codex exec` jobs and interactive sessions with their prompt and last tool call; jobs started from a Claude Code session show under it |

States: `●` working, `◐` waiting, `○` idle, `✓` done (a finished subagent, or a session that claimed `--done`), `!` stalled (quiet longer than its tool's timeout allows, counting a waited-on background job's output file as activity, or a declared job past its heartbeat), `✗` failed. A Claude Code run whose turn ended while a background shell job is still running (no completion notice or stop yet) counts as working, not idle or done.

A run belongs to a project by, in order: a claim; its working directory, unless it only edits files of another project; its parent's project; the project whose files it edits most; a project path named in its first prompt. Runs that match nothing show under `other`. `--wide` marks the guesses (`~edits`, `~prompt`).

When a session's turn ends with a question for the human and no card, parawatch lists it under ASKED IN CHAT. It reads the Claude desktop app's end-of-turn summary when there is one, else a question at the end of the last message. It is a guess, so agents are told to put questions on cards.

## Adding a runtime

An adapter is one file in `src/adapters/` that implements:

```ts
interface Adapter {
  name: string;
  scan(opts: { sinceMs: number; now: number }): Run[];
}
```

It reads only, reads only files touched since `sinceMs`, and reads only the head and tail of large logs.
