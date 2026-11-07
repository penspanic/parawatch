# parawatch

A control tower for people who run many AI coding agents at once, across several projects and several tasks inside each one.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/app-dark.png">
  <img src="docs/app-light.png" alt="The parawatch desktop app: a chart of the last hour of agent activity per project, then the cards that need you, one with two screenshots and three options." width="560">
</picture>

It answers three questions:

- **What needs me?** Decisions to make, builds or videos to try, things only you can do.
- **What is running?** Every agent session, its subagents and its `codex exec` jobs, grouped by project, with what each one is doing right now.
- **Did my answer reach the agent?** When you answer a card, the agent waiting on it wakes up. You do not go back to the chat to say "I decided".

parawatch is a CLI first. Agents use the CLI, and so can you. There is no server and nothing leaves your machine. On top of the CLI, this repository has a [desktop app](apps/desktop/README.md) (the panel above, a menu bar count, a Dock badge and notifications) and an [Obsidian plugin](plugins/obsidian/README.md) with the same panel in a side pane.

```
$ parawatch status
NEEDS YOU  3
  c1   decide   game/139  Which ending for the shake box?                12m
  c2   try      game/139  Try build 139: does the glass read as glass?    4m
  c3   blocked  app       Install the iPad simulator runtime              1h

AGENTS  5 working
app
  ● Interval lesson screen        1m  Bash: Build the app
  ○ App Director                 24m  PR 18 passed. Waiting for the simulator runtime.
game
  ● Game Director                 1s  Bash: Wait for answers
  ├ ● 139 shake round 2           1s  Bash: Run tests
  ├ ● Generate the level icons    2m  exec: python3 make_icons.py
  └ ● Glass shader pass           9m  Bash: Capture the tank
```

One line per item, always inside the terminal width. Finished subagents fold into a count after five minutes (`parawatch runs --all` shows them). `--wide` adds the runtime and ids. Colors follow `NO_COLOR` and `FORCE_COLOR`.

## Install

There are three parts. Most people want all three.

**The CLI**, which agents and you use:

```
npm install -g parawatch
```

**The agent skill**, so Claude Code and Codex agents learn the protocol on their own:

```
parawatch skill install
```

It links [`skills/parawatch`](skills/parawatch/SKILL.md) into `~/.claude/skills` and `~/.codex/skills`. The installed skill is a link to the copy in the package, so updating parawatch updates the skill.

**The desktop app**, to see and answer cards without a terminal. There is no download yet; [build it from source](apps/desktop/README.md#run-from-source). A build you make yourself is not signed, so on macOS it gets no notifications or Dock badge; the README there explains how to sign it with your own certificate.

### Platforms

| | macOS | Linux | Windows |
|--|--|--|--|
| CLI | used daily | tests pass in CI | not supported yet |
| Desktop app | used daily | untested | untested |
| Agent logs read | Claude Code, Codex | same | |

Node 20 or newer.

## Concepts

| | |
|--|--|
| **Project** | A name and one or more paths. Git worktrees of a path belong to the project too. |
| **Card** | Something that needs the human. Four kinds: `decide` (pick an option or write an answer), `try` (open a build, watch a video, look at a screen), `block` (only the human can do it and the agent is stuck until they do: install, sudo, sign in), `todo` (only the human can do it, but nothing waits on it now: check a bill, register a company). A card remembers the session that opened it, and `--since` keeps when the matter first came up when it is older than the card. |
| **Run** | An agent at work. Most runs are *observed*: parawatch reads the agent's own log. Jobs that leave no log (a bake, a benchmark) can be *declared* with `parawatch run start`. |
| **Lead** | A role, not a concept of its own. Claim a session with `--role lead` and it shows at the top of its project with its children under it. |

## For the human

```
parawatch status                 # what needs you, then what is running
parawatch cards                  # open and answered cards
parawatch show c4                # one card with its body, options and attachments
parawatch answer c4 -c 2         # pick option 2
parawatch answer c4 -m "fill it to the rim"          # or just say something
parawatch answer c5 -m "glass is too dark" --attach ~/Desktop/shot.png
parawatch runs --since 12        # agents seen in the last 12 hours
parawatch runs -p game --all    # include finished ones
parawatch runs --wide            # with runtime and ids
```

Register projects once:

```
parawatch project add game ~/dev/game
parawatch project add app ~/dev/app ~/notes/app
parawatch claim 811a9612 -p game --role lead --title "Game Director"
```

`claim` is for sessions that do not start inside a project path (an agent run from a notes folder, a scratch directory). Children of a claimed session follow it.

## For agents

Add the agent protocol to a project's instruction file:

```
parawatch init -f AGENTS.md -p game     # or CLAUDE.md
```

It writes a short block between `<!-- parawatch:begin -->` and `<!-- parawatch:end -->` and replaces it in place on later runs. The protocol in short:

```
parawatch ask -p game "Which ending?" -o "Side tank" -o "Top box" -r 2 -b "two or three lines"
parawatch try -p game "Try build 139" --open /path/Game.app --look "does the glass read?"
parawatch block -p app "Install the iPad simulator runtime"
parawatch todo -p game "Check the GitHub bill" --since 2026-10-01
parawatch wait -p game           # run in the background; exits when the human answers
parawatch comment c4 "baking the top box now"   # a note on the card; does not wake anyone
parawatch close c4 -n "used the top box"
```

`parawatch edit <card>` changes a card after the fact: its kind, wording, task, who asked or `--since`. `parawatch goto <card>` opens the session that asked in the Claude desktop app (`--copy` also puts a line about the card on the clipboard, to paste there); sessions outside the desktop app get the `claude --resume` command instead.

`wait` prints the answers and exits with code 0. With `--timeout <seconds>` it exits with code 2 when nothing came. An answer given before `wait` starts is not lost: each consumer has its own cursor, and `wait` returns everything after it.

### Agent skill

[`skills/parawatch/SKILL.md`](skills/parawatch/SKILL.md) teaches an agent the whole protocol: claiming its session, writing a good card, keeping one background wait armed, closing cards, declaring long jobs, and who asks the human when a lead runs workers. Install it with `parawatch skill install` (see [Install](#install)); `parawatch skill path` prints where it lives, for runtimes that load skills from elsewhere.

`claim`, `run start` and every card command pick up the calling session from `$CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID`), so an agent can put itself on the board without knowing its id.

### Waking a Claude Code session

Claude Code re-invokes a session when one of its background commands exits. So an agent that runs `parawatch wait -p <project>` as a background command is woken by your answer, with the answer as the command's output.

As a backstop, the hook adds any unhandled answers to the next turn of a session in that project:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "parawatch hook claude-code" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "parawatch hook claude-code" }] }]
  }
}
```

The hook only peeks. The agent's own `wait` or `inbox` moves its cursor.

### Other runtimes

Anything that can run a command and notice when it exits can use `wait`. `parawatch inbox` returns at once (add `--peek` to leave the cursor where it is), for runtimes that poll.

## Observed agents

parawatch reads agent logs. It never writes to them and never sends them anywhere.

| Runtime | Where it reads | What it shows |
|--|--|--|
| Claude Code | `~/.claude/projects/*/<session>.jsonl` and `<session>/subagents/` (or `$CLAUDE_CONFIG_DIR`) | sessions with their title, subagents with their description and model, the tool in flight |
| Codex | `~/.codex/sessions/` (or `$CODEX_HOME`) | `codex exec` jobs and interactive sessions with their prompt and last tool call; jobs started from a Claude Code session show under it |

States: `●` working, `◐` waiting, `○` idle, `✓` done, `!` stalled (quiet longer than its tool's timeout allows), `✗` failed.

Runs that match no registered project show under `other`. A run belongs to a project by, in order: a claim, its working directory, its parent's project, a project path named in its first prompt.

### Adding a runtime

An adapter is one file in `src/adapters/` that implements:

```ts
interface Adapter {
  name: string;
  scan(opts: { sinceMs: number; now: number }): Run[];
}
```

It reads only, reads only files touched since `sinceMs`, and reads only the head and tail of large logs.

## Apps, plugins and dashboards

| | |
|--|--|
| [`apps/desktop`](apps/desktop/README.md) | The desktop app. Reads and writes the store directly, so it works without the CLI on `PATH`. |
| [`plugins/obsidian`](plugins/obsidian/README.md) | The Obsidian plugin. Runs the CLI. |
| [`packages/panel`](packages/panel) | The panel both of them show, as plain DOM, with a harness page for working on it. |

Anything else can build on the same two commands:

```
parawatch status --json          # one snapshot: projects, cards, runs
parawatch watch                  # every new event as one JSON line
parawatch watch --from 120       # starting after event 120
```

## Storage

Everything lives in one append-only file, `~/.local/state/parawatch/events.jsonl` (`$PARAWATCH_HOME`, or `$XDG_STATE_HOME/parawatch`). Writers take a short lock, so several agents can write at once. Cursors live next to it in `cursors/`. Delete the folder to start over.

Desktop notifications for new cards use `osascript` on macOS and `notify-send` on Linux. `PARAWATCH_NOTIFY=0` turns them off. While the desktop app runs it notifies instead, and the CLI stays quiet. To-dos never notify.

## Not goals

- Starting or steering agents. Use whatever you already use; parawatch only watches and carries answers back.
- A shared team tracker. It is for one person and their agents, on one machine.
- Replacing your issue tracker. Cards are short-lived questions, not the backlog.

## License

MIT
