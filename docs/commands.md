# Commands

What you run yourself. What agents run is in [Agents](agents.md).

## Concepts

| | |
|--|--|
| **Project** | A name, and optionally one or more paths. Git worktrees of a path belong to the project too. |
| **Claim** | An agent session saying what it works on: a project, a task (a ticket key, a pull request, a short name), a title. It is the main way runs are grouped; guesses from the log are the fallback. A claim can also say the work is done. |
| **Card** | Something that needs the human. Four kinds: `decide` (pick an option or write an answer), `try` (open a build, watch a video, look at a screen), `block` (only the human can do it and the agent is stuck until they do: install, sudo, sign in), `todo` (only the human can do it, but nothing waits on it now: check a bill, register a company). A card remembers the session that opened it, and `--since` keeps when the matter first came up when it is older than the card. |
| **Run** | An agent at work. Most runs are *observed*: parawatch reads the agent's own log. Jobs that leave no log (a bake, a benchmark) can be *declared* with `parawatch run start`, with a heartbeat if they can hang silently. |
| **Pull request** | Read through `gh`. Linked to the session that owns it, so its news wakes that session. |
| **Lead** | Claim a session with `--role lead` and it shows at the top of its project with its children under it. One per project: it gets what no session owns there and what ended sessions left open. With no lead, those wait in parawatch until the human picks one. |

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
parawatch runs --every           # each run of a scheduled task, not one row per task
parawatch run hide <id>         # hide a run (6+ characters of its id) until it does something new; `runs --all` still shows it
parawatch run unhide <id>
parawatch pr list                # open pull requests: what each waits on, since when, whose it is
parawatch goto api#88            # open the session that owns a pull request
parawatch lead game 811a9612     # make a session the project's lead; it is handed what no session got
parawatch hand c12 811a9612      # give a card (or a pull request: api#88) to another session
parawatch digest                 # what each session did today (--date, --json)
```

Agents say what they work on themselves (`parawatch claim`, below), so nothing has to be registered. Registering a project's paths groups the sessions that start inside it even when they do not claim:

```
parawatch project add game ~/dev/game
parawatch project add app ~/dev/app ~/notes/app
parawatch claim 811a9612 -p game --role lead --title "Game Director"   # claim a session for it
```

Children of a claimed session follow it.

## Reading `status`

One line per item, always inside the terminal width. Finished subagents fold into a count after five minutes (`parawatch runs --all` shows them). `--wide` adds the runtime and ids. Colors follow `NO_COLOR` and `FORCE_COLOR`.
