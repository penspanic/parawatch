# Agents

Add the agent protocol to a project's instruction file:

```
parawatch init -f AGENTS.md -p game     # or CLAUDE.md
```

It writes a short block between `<!-- parawatch:begin -->` and `<!-- parawatch:end -->` and replaces it in place on later runs. The protocol in short:

```
parawatch claim -p api -t ABC-1234 --title "Fix the login redirect"   # as soon as the work is clear
parawatch pr link https://github.com/acme/api/pull/88                 # when it opens a pull request
parawatch ask -p game "Which ending?" -o "Side tank" -o "Top box" -r 2 -b "two or three lines"
parawatch ask -p api "Merge PR 88?" --action "gh pr merge 88 --squash" --preview note.md   # an approval
parawatch try -p game "Try build 139" --open /path/Game.app --look "does the glass read?"
parawatch block -p app "Install the iPad simulator runtime"
parawatch todo -p game "Check the GitHub bill" --since 2026-10-01
parawatch wait                   # run in the background; exits when the human answers
parawatch comment c4 "baking the top box now"   # a note on the card; does not wake anyone
parawatch close c4 -n "used the top box"
parawatch run start -p game "overnight bench" --heartbeat 600 --log bench.log   # a job with no agent log
parawatch claim --done "Merged #88; login works on staging"                    # when the work is finished
```

An agent claims the project the work is for, not the folder it runs in, and claims again when it moves to other work. A claim of `--kind scheduled` folds the runs of a schedule into one row. `--done` marks the session finished until someone writes to it again, and its line goes into the digest.

An approval (`ask --action`) shows the exact command and the text it sends, with Do it and Don't, so the human can say yes without opening the session.

The human can dismiss a card that no longer matters, with the x on the card in the app or `parawatch dismiss <card> -n "why"`. The card closes without an answer, and the agent that asked gets "dismissed by the human" at its next `wait` or `inbox`.

`parawatch edit <card>` changes a card after the fact: its kind, wording, task, who asked or `--since`. `parawatch goto <card>` opens the session that asked in the Claude desktop app (`--copy` also puts a line about the card on the clipboard, to paste there); sessions outside the desktop app get the `claude --resume` command instead.

`wait` prints the answers, and news on linked pull requests, and exits with code 0. Run from an agent session, it reads that session's own cards and pull requests, and the ones no session owns in the project it claimed, with a cursor of its own: four sessions in one project each wake only for their own news. A lead waits the same way: it is not woken by cards or pull requests another live session owns. What no session owns, and what a session that has ended left open, goes to the project's lead (the session that last claimed it with `--role lead`) and to no other session; a pull request already merged or closed wakes no one. With no lead, it waits in parawatch: `status` lists it under NO SESSION GETS THESE and the panel under a life-buoy group, whose Help button picks a lead from the project's sessions. `parawatch lead <project> <session>` does the same from the command line, and `parawatch hand <card or PR> <session>` gives one item to a session; either way the session is told once. `wait -p <project>` names a project other than the claimed one; outside a session it reads everything in that project. With `--timeout <seconds>` it exits with code 2 when nothing came. An answer given before `wait` starts is not lost: each consumer has its own cursor, and `wait` returns everything after it. While a `wait` runs, cards say an agent is waiting; when none does, an answered card says the answer is kept until the agent next checks.

## Agent skill

[`skills/parawatch/SKILL.md`](../skills/parawatch/SKILL.md) teaches an agent the whole protocol: claiming its session, writing a good card, keeping one background wait armed, closing cards, declaring long jobs, and who asks the human when a lead runs workers. Install it with `parawatch skill install` (see [Install](../README.md#install)); `parawatch skill path` prints where it lives, for runtimes that load skills from elsewhere.

`claim`, `run start` and every card command pick up the calling session from `$CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID`), so an agent can put itself on the board without knowing its id. A process one agent starts inherits its variables, so a `codex exec` worker launched by a Claude Code session has both. Then the command belongs to the nearer agent, found by walking up the process tree from the command (Claude Code names its process in `$CLAUDE_PID`). When the tree cannot be read, as inside Codex's sandbox, the Codex thread wins: a Claude Code session launching Codex workers is the usual way both are set.

## Waking a Claude Code session

Claude Code re-invokes a session when one of its background commands exits. So an agent that runs `parawatch wait` as a background command is woken by your answer, with the answer as the command's output.

As a backstop, the hook adds the session's unhandled answers and pull request news to its next turn:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "parawatch hook claude-code" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "parawatch hook claude-code" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "parawatch hook claude-code" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "parawatch hook claude-code" }] }]
  }
}
```

The hook only peeks. The agent's own `wait` or `inbox` moves its cursor.

`PermissionRequest` and `Notification` tell parawatch when a session is held by a permission prompt. In the log a prompt looks the same as a long command (a tool call with no result yet), so without them such a session shows as stalled after 20 minutes, with "or a permission prompt is open". With them it shows under NEEDS YOU at once, as "approve a tool call: <tool>", until the tool call returns. The hook never answers the prompt.

## Codex

A Codex session cannot keep a wait running in the background, so it reads `parawatch inbox` at the start of each turn. When it runs in the Codex app, it does not have to wait for that turn: the Codex app runs a message queued for one of its threads (`codex queue --thread <id>`) as soon as the thread is loaded, even while another thread is on screen.

While the Parawatch desktop app runs, it does that for every Codex session the Codex app has loaded (its log is held open by the app's server) and that has something in parawatch: a claim, an open card, or a linked pull request. It holds a wait for each, so their cards say an answer reaches them, and when an answer or pull request news arrives it queues it to the thread as one message, with the same lines `parawatch wait` prints, and takes it off the session's inbox. It does so only while the thread is between turns (its log's last turn event is an end): the Codex app runs a queued message only after the running turn, and a turn that loops on `parawatch wait --timeout` would lose the news to the queue between two waits. During a turn, the session's own wait takes the news; what is still there when the turn ends is passed then.

- A session that runs `parawatch wait` itself is left to that wait.
- Sub-agent threads (their log starts with `thread_source: "subagent"`) are left alone; the Codex app takes no queued messages for them.
- A thread the Codex app has not loaded is left alone: it reads its inbox on its next turn. Opening it in the Codex app is enough; from then on it is woken.
- If `codex queue` fails, the news stays in the inbox and the app tries again five minutes later; the app's log says why.
- Settings > "Wake Codex sessions" turns it off. It needs macOS or Linux (it reads which files the Codex app holds open with `lsof`) and a `codex` command that has `queue` (codex-cli 0.170 does).

## Other runtimes

Anything that can run a command and notice when it exits can use `wait`. `parawatch inbox` returns at once (add `--peek` to leave the cursor where it is), for runtimes that poll.
