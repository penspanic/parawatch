---
name: parawatch
description: How an agent works with a human through parawatch. Use whenever you need something from the human (a decision, an approval, trying a build or looking at a capture, an action only they can do such as installing, signing in or sudo), when you lead or coordinate other agents on a project, when you start a long job that leaves no agent log (CI wait, bake, benchmark), and at the start of a session in a project that uses parawatch (its AGENTS.md or CLAUDE.md has a parawatch block, or `parawatch project list` shows it). Covers claiming your session, opening good cards, waiting for answers in the background, closing cards and declaring runs. Not for talking to other agents, and not a task tracker.
---

# parawatch

The human watches every project and agent from `parawatch status` and a side panel, and answers there. Anything you need from them goes through parawatch, not through chat or a document they have to remember to check. Their answer wakes you.

## 1. At the start of a session

```
parawatch project list
```

If the project you work on is listed, put yourself on the board:

```
parawatch claim -p <project> --role lead --title "<what you are, e.g. Game Director>"   # if you lead the project
parawatch claim -p <project> --title "<your task>"                                        # otherwise
```

`claim` without a session id uses the calling session (`$CLAUDE_CODE_SESSION_ID`). Cards you open record your session too, so the human can jump from a card to you; claim first so the card shows your title. Your subagents and the `codex exec` jobs you start show under you on their own.

If the project is not listed and the human wants it tracked: `parawatch project add <name> <repo path> [<notes folder>]`. Git worktrees of a registered path belong to the project automatically.

Then check what is already waiting so you do not ask twice:

```
parawatch cards -p <project>
parawatch inbox -p <project> --peek
```

## 2. Asking the human

One question per card. Pick the kind by what the human has to do:

| Need | Command |
|--|--|
| A choice | `parawatch ask -p <project> "<the question>" -o "<option>" -o "<option>" -r <n> -b "<why it matters now>"` |
| An open answer | `parawatch ask -p <project> "<the question>" -b "<context>"` |
| Try a build, watch a video, look at a screen | `parawatch try -p <project> "<what to try>" --open <app, file or URL> --attach <image or video> -l "<what to look at>"` |
| Something only they can do, and you are stuck until they do | `parawatch block -p <project> "<what to do>" -b "<exact steps>"` |
| Something only they can do, but nothing waits on it now | `parawatch todo -p <project> "<what to do>" -b "<exact steps, and by when>"` |

A good card:

- **The title is the question or the request**, readable alone in a list: "Ship the top-box ending?" not "Ending".
- **The body is two or three lines**: what changed, what it affects, what happens if they do not answer. It renders as Markdown.
- **Write in the human's words**: what they will see or feel in the product, not ticket numbers, metrics, engine terms or internal ids. Put those in an attachment or a link at the end of the body.
- **Options are exclusive and concrete, and each says what happens if picked.** Recommend one with `-r` when you have a view; say why in the body.
- **Attach evidence** with absolute paths: screenshots, short videos, logs. `--open` takes what they should launch (an `.app`, a file, a URL).
- **Add `-t <task>`** when the project runs several tasks at once, so the human can tell them apart.
- **`block` is red and counts as needing them now.** Use it only when your work stops until they act. Errands for later (a bill, a registration, a policy check, a measurement whenever the machine is free) are `todo`; they wait folded in the panel and do not pop up.
- **Moving items from a board or a note:** pass `--since <YYYY-MM-DD>` with the date the item first came up, so the card does not look new. `parawatch edit <card>` fixes a card's kind, wording or date later.
- Do not open a card for something you can decide yourself, or that the project's own rules already settle.

## 3. Waiting for the answer

Right after opening cards, keep exactly one wait armed for your project:

- **Claude Code**: run `parawatch wait -p <project>` as a background Bash command (`run_in_background: true`). When the human answers, the command exits, its output is the answer, and you are woken. Do not poll, do not sleep-loop, do not start a second wait while one is running.
- **Other runtimes**: check `parawatch inbox -p <project>` at the start of every turn.

Keep working on other things meanwhile. A wait with `--timeout <seconds>` exits with code 2 when nothing came; re-arm it if you still need the answer.

## 4. Handling an answer

The output looks like `[project] c4 "Ship the top-box ending?" chose 2 (Top box); said: fill it to the rim; attached: /path/shot.png`.

1. Act on it. Read attached files; they are the human's evidence.
2. If the answer is a lasting decision, record it where the project keeps decisions (a design doc, an ADR), not only in the card.
3. Close the card with what you did: `parawatch close c4 -n "Top box shipped in #212"`.
4. If more cards are open, arm the wait again.

To add information to a card without waking anyone, use `parawatch comment <card> "<text>"`. Never answer a card yourself: `answer` is the human's.

## 5. Long jobs that leave no agent log

A CI run, a render, a benchmark, a deploy you are waiting on:

```
id=$(parawatch run start -p <project> "PR 212 CI")
parawatch run note $id "UI tests running"
parawatch run end $id                 # or: parawatch run end $id --failed -n "UI test timed out"
```

The run shows under your session. End it when it ends, or it keeps showing as working.

Do not declare runs for things parawatch already sees in their own logs: Claude Code sessions and subagents, and `codex exec` jobs, show up by themselves. A declared run on top of them is a duplicate.

## 6. Leads and workers

- The lead owns the cards for its project. Workers (subagents, `codex exec` jobs, other sessions you start) report back to the lead instead of opening cards, unless the lead told them to ask the human directly.
- Tell workers in their brief what to return to you, so the lead can turn it into one clear card.
- Before ending a session, close cards you handled and end runs you started.

## Quick reference

```
parawatch status                     # everything: what needs the human, what is running
parawatch runs -p <project> --wide   # agents with ids
parawatch show <card>                # one card in full
parawatch cards -p <project> -a      # include closed cards
```
