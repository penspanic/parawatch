---
name: parawatch
description: How an agent works with a human through parawatch. Use whenever you need something from the human (a decision, an approval of a prepared step, trying a build or looking at a capture, an action only they can do such as installing, signing in or sudo), as soon as you know what you are working on in a session where parawatch is set up (its AGENTS.md or CLAUDE.md has a parawatch block, or `parawatch project list` shows projects), when you open a pull request, when you finish your work, when you lead or coordinate other agents, and when you start a long job that leaves no agent log (CI wait, bake, benchmark). Covers claiming your work, linking pull requests, opening good cards, waiting for answers and PR news in the background, closing cards, finishing, and declaring runs. Not for talking to other agents, and not a task tracker.
---

# parawatch

The human watches every project and agent from `parawatch status` and a side panel, and answers there. Anything you need from them goes through parawatch, not through chat or a document they have to remember to check. Their answer wakes you.

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

One question per card. Pick the kind by what the human has to do:

| Need | Command |
|--|--|
| A choice | `parawatch ask -p <project> "<the question>" -o "<option>" -o "<option>" -r <n> -b "<why it matters now>"` |
| Approval of a step you have prepared (merge, post, move a ticket, send a message, force-push) | `parawatch ask -p <project> "<what and why, as a question>" --action "<the exact command or step>" --preview <file with the text it sends>` |
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
- **`--action` is the exact command, one line if possible.** Steps and reasons go in the body, and `--preview` is the file with the text it sends (the human can open that file from the card). Change `--action`, `--preview` or `--attach` with `parawatch edit` while the card is unanswered; once answered, close it and open a new one.
- **An approval shows exactly what runs.** With `--action` the human sees the command and the preview and answers Do it or Don't, without opening your session. Run exactly that on yes; say in the close note that you ran it.
- **Never leave a question only in your reply.** If your turn ends needing the human, the question goes on a card. Parawatch flags questions it finds at the end of a turn as "asked in chat, no card", but that is a guess and easy to miss.
- Do not open a card for something you can decide yourself, or that the project's own rules already settle.

## 3. Pull requests

When you open a pull request, link it to yourself:

```
parawatch pr link <url>          # or #88 inside the repository
```

A pull request you open with `gh pr create` is linked from your log on its own, but say it anyway; it costs nothing and survives a long session. When `gh` is installed and signed in, parawatch reads your pull requests from GitHub (GitHub Enterprise too). New reviews, requested changes, approvals, CI failures, conflicts, a drop from the merge queue and the merge itself arrive at your wait like an answer. The human sees the PR, what it waits on and for how long, next to your session.

News from somewhere GitHub does not show (a merge bot, a ticket system) can be recorded by any tool: `parawatch pr event <url> <change> -m "<what happened>"`.

## 4. Waiting for the answer

Right after opening cards or linking a pull request, keep exactly one wait armed:

- **Claude Code**: run `parawatch wait` as a background Bash command (`run_in_background: true`). When the human answers, the command exits, its output is the answer, and you are woken. Do not poll, do not sleep-loop, do not start a second wait while one is running.
- **Other runtimes**: check `parawatch inbox` at the start of every turn.

Inside your session, `wait` and `inbox` read only what is yours: answers on cards you opened, news on pull requests linked to you, and in the project you claimed, cards and pull requests no session owns or whose session has ended. Other sessions in the same project are not woken by your news and cannot take it from you, and you are not woken by theirs. This holds for a lead too. `-p <project>` only names a project other than the one you claimed.

Keep working on other things meanwhile. A wait with `--timeout <seconds>` exits with code 2 when nothing came; re-arm it if you still need the answer. While no wait runs, an answer is kept, and the card tells the human that no agent is waiting; it reaches you on your next turn or your next wait.

## 5. Handling an answer

The output looks like `[project] c4 "Ship the top-box ending?" chose 2 (Top box); said: fill it to the rim; attached: /path/shot.png`, or for a pull request `[project] PR acme/api#88 "Fix login": changes requested by alice (https://…)`.

1. Act on it. Read attached files; they are the human's evidence.
2. If the answer is a lasting decision, record it where the project keeps decisions (a design doc, an ADR), not only in the card.
3. Close the card with what you did: `parawatch close c4 -n "Top box shipped in #212"`.
4. If more cards are open, or a linked pull request is not merged yet, arm the wait again.

A card can also come back as `[project] c4 "…" dismissed by the human: no longer needed, do not act on it`. The human closed it without answering. Drop that step, do not open the card again, and go on with the rest of the work.

To add information to a card without waking anyone, use `parawatch comment <card> "<text>"`. Never answer a card yourself: `answer` is the human's.

## 6. Long jobs that leave no agent log

A render, a benchmark, an editor build, a deploy you are waiting on:

```
id=$(parawatch run start -p <project> "overnight bench" --heartbeat 600 --log /path/bench.log)
parawatch run note $id "scene 3 of 8"   # also counts as a beat
parawatch run beat $id                  # still alive, nothing to say
parawatch run end $id                   # or: parawatch run end $id --failed -n "editor stopped ticking"
```

The run shows under your session. With `--heartbeat`, it turns stalled when no beat, note or log change comes in that many seconds, so a job that hangs silently (a locked screen, App Nap) shows at once. End it when it ends, or it keeps showing as working. Do not poll a job with sleep loops; declare it and arm a wait.

Do not declare runs for things parawatch already sees in their own logs: Claude Code sessions and subagents, and `codex exec` jobs, show up by themselves. A declared run on top of them is a duplicate.

## 7. Finishing

When your work is finished, say so with one line on how it ended:

```
parawatch claim --done "Merged #88; login works on staging"
```

The session then shows as done, not as idle, and the line goes into the human's daily digest (`parawatch digest`). It stays done until someone writes to the session again. Close the cards you handled first: cards still open and pull requests not yet merged pass to the other sessions in the project, and their news wakes them. News on your pull requests that are already merged or closed wakes no one else.

## 8. Leads and workers

- A lead waits like any session, with a plain `parawatch wait`. It gets its own news, cards and pull requests no session owns in its project, and those of sessions that have ended.
- The lead owns the cards for the work it hands out. Workers (subagents, `codex exec` jobs, other sessions you start) report back to the lead instead of opening cards, unless the lead told them to ask the human directly.
- A session the human started on their own asks the human directly. Its cards and pull requests are its own: answers and news on them go to it, not to the lead. When that work belongs in the lead's queue, the session tells the lead, not the other way round.
- Tell workers in their brief what to return to you, so the lead can turn it into one clear card.
- Before ending a session, close cards you handled, end runs you started, and claim `--done`.

## On more than one machine

When `parawatch sync` shows other machines, the human may answer from any of them. Nothing changes in how you ask or wait. Ids then carry the machine (`pc-c3`); use the id the command printed. Attach files under your home folder or the shared folder (or a folder named with `parawatch sync root`), so the human's machine can open them. An app path given to `try --open` only opens on the machine that has it, so say in the body which machine to try it on.

## Quick reference

```
parawatch status                     # everything: what needs the human, what waits on others, what is running
parawatch runs -p <project> --wide   # agents with ids
parawatch run hide <id>              # the human asks to hide a run; it returns when it does something new
parawatch pr list                    # open pull requests and what each waits on
parawatch digest                     # what each session did today
parawatch show <card>                # one card in full
parawatch cards -p <project> -a      # include closed cards
```
