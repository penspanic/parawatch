---
name: parawatch
description: How an agent works with a human through parawatch. Use whenever you need something from the human (a decision, an approval of a prepared step, trying a build or looking at a capture, an action only they can do such as installing, signing in or sudo), as soon as you know what you are working on in a session where parawatch is set up (its AGENTS.md or CLAUDE.md has a parawatch block, or `parawatch project list` shows projects), when you open a pull request, when you finish your work, when you lead or coordinate other agents, and when you start a long job that leaves no agent log (CI wait, bake, benchmark). Covers claiming your work, linking pull requests, opening good cards, waiting for answers and PR news in the background, closing cards, finishing, and declaring runs. Not for talking to other agents, and not a task tracker.
---

# parawatch

The human watches every project and agent from `parawatch status` and a side panel, and answers there. Anything you need from them goes through parawatch, not through chat or a document they have to remember to check. Their answer wakes you.

**A worker a lead started** (a subagent, a `codex exec` job, a session with a brief) needs only three commands, unless the brief says otherwise: `parawatch claim -p <project> -t <task> --title "<what you do>"` when you start, `parawatch pr link <url>` when you open a pull request, and `parawatch claim --done "<how it ended>"` at the end. Report everything else to the lead. You can stop reading here.

This page is the core. The rest prints with `parawatch guide <topic>` from the installed parawatch, so it always matches the command you run: `cards` (writing a good card), `attachments` (captions, comparisons, pictures tied to choices), `prs`, `runs` (long jobs), `lead` (leads and workers), `machines`. The same pages are in this skill's `references/` folder.

## 1. Say what you work on, as soon as you know

The human sees agents grouped by project and task. Parawatch can only guess from the folder a session started in, and many people start every session in the same home or notes folder. So say it yourself, the moment the work is clear (from the first message, or once you have read enough to know):

```
parawatch claim -p <project> -t <task> --title "<what you do, in a few words>"
parawatch claim -p <project> --role lead --title "<what you are, e.g. Game Director>"   # if you lead the project
```

- **Claim the project the work is for, not the folder you run in.** A session started in a notes folder that changes the `api` repository claims `api`.
- **`-t` is the unit of work**: a ticket key (`ABC-1234`), a pull request (`#88`), or a short name. It is how the human tells two sessions in one project apart.
- **Claim again when the work changes** (the next ticket, another repository). The latest claim wins.
- A project does not have to be registered to be claimed. `parawatch project list` shows the names already in use; reuse one when it fits.
- A session a schedule starts again and again adds `--kind scheduled`, so its runs fold into one row.

`claim` without a session id uses the calling session (`$CLAUDE_CODE_SESSION_ID`). Cards you open record your session too, so the human can jump from a card to you; claim first so the card shows your title. Your subagents and the `codex exec` jobs you start show under you on their own.

To register a project so sessions started inside it are grouped without a claim: `parawatch project add <name> <repo path> [<notes folder>]`. Git worktrees of a registered path belong to the project automatically.

Then check what is already waiting so you do not ask twice:

```
parawatch cards -p <project>
parawatch inbox -p <project> --peek
```

## 2. Asking the human

One question per card, in the human's words:

```
parawatch ask -p <project> "<the question>" -o "<choice>" -o "<choice>" -r <n> -b "<two or three lines: why it matters now>"
parawatch ask -p <project> "<what and why, as a question>" --action "<the exact command that runs on yes>" --preview <file>
parawatch try -p <project> "<what to try>" --open <app, file or URL> --attach "<caption>=<image or video>" -l "<where to look>"
parawatch block -p <project> "<what only they can do>" -b "<exact steps>"    # you are stuck until they do it
parawatch todo -p <project> "<what only they can do>" -b "<exact steps, by when>"   # nothing waits on it now
```

- **The title is the question**, readable alone in a list. Options are exclusive, and each says what happens if picked.
- **Caption every picture** (`--attach "Now=/abs/now.png"`) and tie pictures to their choices (`--option-attach "2=Outline"`); show before and after with `--compare`. Do not point at pictures by their place in the body. `parawatch guide attachments`.
- **Never leave a question only in your reply.** If your turn ends needing the human, the question goes on a card.
- More on cards, approvals and when not to ask: `parawatch guide cards`.

When you open a pull request, link it to yourself so its reviews, CI results and merge wake you: `parawatch pr link <url>` (`parawatch guide prs`).

## 3. Waiting for the answer

Right after opening cards or linking a pull request, keep exactly one wait armed:

- **Claude Code**: run `parawatch wait` as a background Bash command (`run_in_background: true`). When the human answers, the command exits, its output is the answer, and you are woken. Do not poll, do not sleep-loop, do not start a second wait while one is running.
- **Codex**: check `parawatch inbox` at the start of every turn. In the Codex app you are also woken: while the Parawatch app runs, an answer or pull request news arrives in your thread as a message starting "parawatch: news for this session", with the same lines a wait prints. Handle it like a wait's output; it is already off your inbox.
- **Other runtimes**: check `parawatch inbox` at the start of every turn.

Inside your session, `wait` and `inbox` read only what is yours: answers on cards you opened and news on pull requests linked to you. Other sessions in the same project are not woken by your news and cannot take it from you, and you are not woken by theirs. What no session owns, and what a session that has ended left open, goes to the project's lead (`parawatch guide lead`); with no lead it waits in parawatch until the human picks one. `-p <project>` only names a project other than the one you claimed.

If the human hands you a card or a pull request (`parawatch hand`), your wait prints `[project] c4 "..." handed to you by the human; the answer: ...`. It is yours from then on: act on it and close it like your own.

Re-arming the wait after each wake is the intended use; the wake is what costs, not the re-arm. Do not keep `parawatch watch` running instead: it is for plugins and monitors, streams every event of every project with none of the session or lead filtering above, and would wake you more often, not less.

Keep working on other things meanwhile. A wait with `--timeout <seconds>` exits with code 2 when nothing came; re-arm it if you still need the answer. While no wait runs, an answer is kept, and the card tells the human that no agent is waiting; it reaches you on your next turn or your next wait.

## 4. Handling an answer

The output looks like `[project] c4 "Ship the top-box ending?" chose 2 (Top box); said: fill it to the rim; attached: /path/shot.png`, or for a pull request `[project] PR acme/api#88 "Fix login": changes requested by alice (https://…)`.

1. Act on it. Read attached files; they are the human's evidence.
2. If the answer is a lasting decision, record it where the project keeps decisions (a design doc, an ADR), not only in the card.
3. Close the card with what you did: `parawatch close c4 -n "Top box shipped in #212"`.
4. If more cards are open, or a linked pull request is not merged yet, arm the wait again.

A card can also come back as `[project] c4 "…" dismissed by the human: no longer needed, do not act on it`. The human closed it without answering. Drop that step, do not open the card again, and go on with the rest of the work.

To add information to a card without waking anyone, use `parawatch comment <card> "<text>"`. Never answer a card yourself: `answer` is the human's.

## 5. Long jobs that leave no agent log

A CI run, a render, a benchmark, a deploy you wait on: run it through parawatch, so it shows under your session and ends with the command.

```
parawatch run watch "CI for #88" -p <project> -- gh run watch 123 --exit-status
```

A job you cannot wrap in one command is declared with `run start`, `run note` and `run end`: `parawatch guide runs`. Claude Code sessions, subagents and `codex exec` jobs show up by themselves; do not declare runs for them.

## 6. Finishing

When your work is finished, say so with one line on how it ended:

```
parawatch claim --done "Merged #88; login works on staging"
```

The session then shows as done, not as idle, and the line goes into the human's daily digest (`parawatch digest`). It stays done until someone writes to the session again. Close the cards you handled first: cards still open and pull requests not yet merged pass to the project's lead, or wait in parawatch when there is none. News on your pull requests that are already merged or closed wakes no one else.

Leading other agents: `parawatch guide lead`. Working across machines: `parawatch guide machines`.

## Quick reference

```
parawatch status                     # everything: what needs the human, what waits on others, what is running
parawatch runs -p <project> --wide   # agents with ids
parawatch run hide <id>              # the human asks to hide a run; it returns when it does something new
parawatch pr list                    # open pull requests and what each waits on
parawatch digest                     # what each session did today
parawatch show <card>                # one card in full
parawatch cards -p <project> -a      # include closed cards
parawatch guide <topic>              # cards, attachments, prs, runs, lead, machines
```
