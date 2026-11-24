# Changelog

## 0.3.35 (2026-11-24)

- Moving the playhead of a video on a card now works, in the card and full screen. The app sent a video file whole instead of the part the player asked for, so the player took it as a video it cannot move in and went on from where it was playing. It now sends the asked-for bytes.
- On Windows, files from the relay reach the shared folder again when something holds them for a moment. A file is written beside its place and then swapped in; when Windows refused the swap (a virus scanner reading the new file, say), the whole look at the relay failed and was tried again a minute later, failing the same way, so answers and runs from the other machine stopped arriving. The swap now waits a little, then writes over the old file. A file that still cannot be written no longer holds back the others and is fetched again on the next look, and `parawatch sync` says the folder is out of step instead of calling the relay not reachable.

## 0.3.34 (2026-11-24)

- A video on a card stays full screen. Going full screen changed the size of its row, and laying the row out again took the video's cell out of the page and put it back, which ended full screen at once (and paused a playing video whenever the window was resized). Cells now move only when their order changes, and a row with a full screen video waits until it comes back.
- On Windows the app now updates the command line when npm sits under `C:\Program Files\nodejs`. 0.3.32 found that npm but passed its path to cmd.exe unquoted, so cmd ran `C:\Program` and the update failed. Paths with spaces (npm, the install folder, the command's shim, the Codex command) are now quoted.

## 0.3.33 (2026-11-24)

- `parawatch app update` has the desktop app running on this machine check for a new version, download it and restart into it, and ends when the new version runs. An agent runs it when `doctor` says the app is older, so nobody has to press Restart to Update; `doctor` and `status` now name it. The app then brings the command line to its version as before.
- The panel no longer redraws every card when one changes. A card, row or section that looks the same keeps its place on screen, so the reply being typed, its caret, a Korean syllable being composed, a playing video, an open fold and the scroll position stay put when an answer, a comment or pull request news comes in. A card that changes while you type in it waits until you leave the field, and redraws wait while an input method composes a syllable or a click is on its way.

## 0.3.32 (2026-11-23)

- Pictures on a card say what they are. `--attach "Now=/path/now.png"` puts a caption under the picture in the panel and the viewer, `--option-attach "2=Outline"` ties pictures to a choice (its number shows on them, and pointing at the choice lights them and flips comparisons to them), `--compare "Now,Outline"` shows several pictures or videos as one with a tab for each (the viewer keeps the zoom while flipping, and videos keep their moment), and `--grid 3` lays them out in columns of one width. `edit` changes all of these while nobody has answered. Cards stay readable by older copies, which show the files as before.
- A card with several pictures and no captions prints a hint with the edit to make.
- `parawatch guide [topic]` prints how agents work with parawatch for the installed version. The skill is now a short core (a worker's three commands come first) with reference pages for cards, attachments, pull requests, long jobs, leads and machines, and the AGENTS.md block now holds only the project, that the human answers on cards, and a pointer to the guide. It names no commands, so later updates no longer leave it behind. Run `parawatch init -f <file> -p <project>` once for a block written before; `doctor` names such a block and gives that command with the project the block already names.
- `parawatch run watch "<title>" -p <project> -- <command>` runs a command as a declared run: it starts with the command, its output counts as beats, and it ends with the command's exit code.
- Commands agents got wrong now answer with what to do: `parawatch link` names `pr link`, `todo` and `block` given choices name `ask`, `digest` takes `-p`, `sync root` with no name lists the named folders, and `lead <project>` without a session picks the calling one. `ask`, `try`, `edit`, `claim`, `run watch` and `pr link` end their help with examples.
- The desktop app keeps the command line up to date on Windows too. It looked for npm only inside the global prefix (`%APPDATA%\npm`), where Windows has none, so the command line stayed at the version first installed. It now also uses the npm beside node (Program Files, nvm) or on the PATH, still installing into the same prefix. When it cannot update the command line it says so once, in its log and in a notification with the command to run.

## 0.3.31 (2026-11-22)

- Going to the session behind a card opens a Codex thread in the Codex app (`codex://threads/<id>`). It said the thread was "not a Claude desktop session" and put `claude --resume <id>` on the clipboard, which cannot resume a Codex thread. Without the Codex app, the clipboard gets `codex resume <id>`.

## 0.3.30 (2026-11-22)

- A machine that lost power no longer loses its unsent cards when it starts again. The relay mirror remembers which version of each shared file it has seen, and a crash while writing that record left it as zeros. Starting with no record, the mirror took the relay's copy of every file that differed, so events written on that machine and not yet sent (cards, answers, claims) were overwritten. Now an event log with no record is joined line by line with the relay's copy and sent up, the record and pulled files are flushed to disk before they replace the old ones, and an event log with zeros in it is not sent.
- A `codex exec` worker launched from a Claude Code session is its own session. It inherits the Claude session's `CLAUDE_CODE_SESSION_ID`, and `claim`, `pr link`, `ask` and `wait` used that, so a worker's task, its done line and its pull requests landed on the director's session (#64). With both ids set, parawatch now takes the nearer agent from the process tree, and the Codex thread when the tree cannot be read (Codex's sandbox).
- Deployments waiting for you. A GitHub Actions job that deploys to an environment with required reviewers waits until one approves it, and GitHub does not tell the person who started it. Parawatch now finds such runs in the repositories of registered projects and shows the ones you can approve: under "Deploys to approve" in the app, DEPLOYS WAITING FOR YOU in `status`, and `parawatch deploy list`. The desktop app notifies when one starts waiting. Approve or Reject on the row, with a second press that names the environment, or `parawatch deploy approve <run>`; from the phone, the machine that read it carries it out. Who decided and how the run ended show under Recent, and a failed deployment is notified.

## 0.3.29 (2026-11-19)

- Codex wake no longer queues news to a thread in the middle of a turn. A turn that loops on `parawatch wait --timeout` lost the news to the Codex queue in the moment between two waits, and the queue runs only after the turn, so the messages piled up unread. Now the session's own wait takes the news during a turn, and what is left when the turn ends is passed then.
- Sub-agent threads in the Codex app are no longer woken. The Codex app refuses queued messages for them, so the Parawatch app tried every five minutes and their cards said an answer reached them.

## 0.3.28 (2026-11-19)

- Codex sessions in the Codex app wake when you answer. While the Parawatch app runs, it passes an answer, or news on a pull request the session owns, to the session's thread with `codex queue`, and the Codex app runs it at once, even while another thread is on screen. This works for threads the Codex app has loaded; others read their inbox on their next turn as before. Their cards say an answer reaches them. Settings > "Wake Codex sessions" turns it off.
- `deploy/relay/setup.sh` can run again and again: it keeps the server's invite when `RELAY_INVITE` is not given, installs parawatch only when the version differs, restarts the relay only when something it runs with changed, and waits for it to answer. The web app is no longer served by the relay's Caddy unless `SERVE_WEB=1`; `APP_DOMAIN` alone now only lets the app call the relay.
- The project's relay and phone web app are deployed from GitHub: after each release a Deploy workflow shows the Terraform plan, waits for the owner's approval, then applies it, brings the relay server to the release and uploads the web app, which now lives in S3 behind CloudFront.
- CONTRIBUTING describes working from a fork and changing the infrastructure; CODEOWNERS asks for the owner's review on `infra/`, `deploy/` and `.github/`.

## 0.3.27 (2026-11-19)

- A desktop notification opens the window at what it was about: the pull request's row, the issue, the thread from a person, or the line under Recent for a pull request that is no longer open. Before, a click on pull request news showed the window with nothing to find. When the window does not show it, the page opens.
- From people: GitHub notifications another person caused (a mention, a review requested, someone else's comment on your thread) show at the top of the app with a bell count, in `status` (FROM PEOPLE ON GITHUB) and with `parawatch news`. The ones your own account made through agents, bots, CI, and news on pull requests a session owns are left out. Opening one, its check button, or `parawatch news done <key>` marks it read on GitHub too.
- Recent: what changed on pull requests and issues in the last day, with the session that owns each, folded at the bottom of the app and in `parawatch news`.
- Fewer notifications: none for news on a pull request a running session owns (the session hears it), none for news read more than 30 minutes after the reading before it (after sleep), several at once told as one, and the same thing told once.

## 0.3.26 (2026-11-18)

- Issues assigned to you on GitHub show next to the reviews asked of you: in `status` (ISSUES ASSIGNED TO YOU), in the app ("Assigned to you", with a count in the header and on the board), and with `parawatch issue list`. Each shows who assigned it, the latest comment by someone else, and the project whose repository it is in. The desktop app notifies when one is assigned to you and when someone else comments on it. They wake no agent. A row can be set aside until someone else comments (`parawatch issue aside`, `parawatch issue back`). They come from the same GitHub reading as pull requests, so no extra calls.
- On the phone, other machines' lanes reach back a day, as on the desktop since 0.3.25; they stopped at an hour.

## 0.3.25 (2026-11-18)

- The line between the agent names and their lanes can be dragged to share the width between them. A double click puts it back; with the keyboard, the arrow keys move it. The width is remembered.
- The lanes can reach back further than an hour: the start of the axis is a menu with 30 minutes, 1, 3, 6, 12 and 24 hours. Runs now keep a day of active minutes (it was an hour). A machine on an older version still sends only its last hour.

## 0.3.24 (2026-11-17)

- A pull request that stays in conflict reports it once. GitHub answers "unknown" for a while each time the base branch moves, and parawatch read that as the conflict gone, so every merge to main woke the owner (or the lead) with the same conflict again. A PR that is fixed and then breaks again still reports it.
- `parawatch pr unlink` stays: a PR someone unlinked is no longer linked again from the log of the session that opened it, so a draft parked for later stops waking anyone until someone links it again.
- The skill says when to re-link (taking over a PR an ended session opened, or briefing a worker to), when to unlink (a PR parked on purpose), and that an agent re-arms `parawatch wait` rather than keeping `parawatch watch` running.

## 0.3.23 (2026-11-17)

- `--open` refuses a command (`&&`, a pipe, `--flags` after the app): parawatch never runs it, and on Windows such a line was stored as a path under the current folder, so every other machine showed it as a file not arrived yet. The error says to put the command in the body as a code block. The skill says the same.
- A file a card from another machine names outside the shared folder (a script on that PC's own drive) shows as "on winpc", not "not on this machine yet": it never comes here, so the panel no longer suggests waiting for it. File names from a Windows machine are shortened at the last backslash too.
- Messages at the bottom of the window have a Copy button, on the desktop app and the phone. For something the card names that is not on this machine, Copy takes the whole of it, not only the name shown.

## 0.3.22 (2026-11-17)

- A session shows its own name and the work it claimed apart: "Spill Director · Model and launch" instead of the work's title alone, which hid which session it was once a lead claimed a task. The name is what the Claude app calls the session (or its log's title); the work is the title of its latest claim. Settings > Agent names picks Both, Session or Work; the phone has the same choice under This phone. A session from a machine on an older version shows its title as before.
- A card's "look at" line (`try -l`) is shown as Markdown, like the body. A body or look line that numbers several points in one line ("1) … 2) … 3) …") is shown as a list, one point per line. The skill now says to keep `-l` to one line and put several points in the body as a list.

## 0.3.21 (2026-11-16)

- A session on another machine opens in the Claude desktop app instead of a browser, when the app is installed: its Remote Control link (`https://claude.ai/code/session_…`) is opened as `claude://claude.ai/code/session_…`, which the app shows like a session of its own. The desktop app does this for rows, lanes and cards, and `parawatch goto` on macOS (falling back to the browser when the Claude app is not there). `goto --print` still prints the web link, and the phone app opens the web link.

## 0.3.20 (2026-11-16)

- Fix: a card asked on another machine did not open its session when clicked, even when that session has a Remote Control link, as its row in the agents list does. It now opens the same way and puts a line about the card on the clipboard; a session there with no link stays plain text.

## 0.3.19 (2026-11-16)

- Fix: Restart to Update on macOS could fail and leave the app closed. The check made just before the restart hands the downloaded update to Squirrel again, which unpacks it anew; the app quit at once, so ShipIt found the update gone or half unpacked, failed its signature check and gave up. The restart now waits until Squirrel has the update in place, and says so and stays open if it does not get there.
- Fix: when ShipIt gave up on an update, the old version it opened again closed itself at once, taking the start for one made in the middle of the install. On macOS a start now steps aside only while ShipIt is still running.

## 0.3.18 (2026-11-15)

- Fix: a long Codex job showed no model or effort. Codex writes them once a turn, and in a log of many megabytes the last one often sits between the start and the end that parawatch reads; it now finds the last one, once per log and then only in what the log adds.

## 0.3.17 (2026-11-15)

- Parawatch on a phone: `apps/web` is the panel as a web app that reads your machines' shared folder through a relay. It shows the cards and agents, answers and dismisses cards, hides runs and opens Claude sessions through their Remote Control links. Pair it with the code `parawatch relay code` prints; the key stays on the phone. `deploy/relay/setup.sh` serves it next to the relay with `APP_DOMAIN`. See [On a phone](docs/phone.md).
- Each agent shows what it runs with: the model and effort on its row (`opus 5.5 high`, `gpt-6.1-sol xhigh`), and in the tooltip the full model name and its options (fast mode and the permission mode for Claude Code; the sandbox and when it asks for Codex). Read from the logs for Claude Code sessions and subagents and for Codex sessions and `codex exec` jobs, the last turn's settings, and passed to the other machines with the rest of the run. `runs --wide` shows them too.
- A lead that claims `--done` is told that it no longer leads the project, and how to go on leading if it keeps working: what no session owns there then waits in parawatch until a session claims the lead. The skill says a lead that finishes one task claims its next work instead. A director that did a worker's task itself took the brief's "do not use parawatch" as its own and claimed done, and the project's answers reached no one for hours.
- Fix: an answer given on one machine in the same millisecond as the card was opened on another, or from a machine whose clock runs behind, could be lost. Logs merge by time and then by machine name, so the answer could sort before the card and count as one for a card that did not exist yet. An event about a card is now stamped after everything already said about that card, and never before the writer's own last event; the phone app did this already and now uses the same rule.
- Fix: news on recently linked pull requests stopped coming. Parawatch reads linked pull requests by number, at most 80 a time, and took the oldest links first; once a machine had more than 80, the newest were never read by number, so their merges and closes never woke anyone. It now reads the newest links first and leaves out the ones it has seen merged or closed.
- Fix: a pull request whose CI ended before parawatch first read it (a CI of a minute) never sent "CI passed" or "CI failed". A pull request a session linked since the last reading now reports its CI, a merge or a close when it is first seen with them already done.
- Fix: `deploy/relay/aws-lightsail.sh` made an instance that never set itself up. Lightsail puts its own lines in front of the launch script and runs it with `sh`, which stopped at the first bash-only line. The launch script now only writes `setup.sh` out and runs it with bash.

## 0.3.16 (2026-11-14)

- The relay: a small server of your own that carries the shared folder between machines in place of Syncthing or a cloud drive. A machine seals every file, its path included, with a key the server never sees, and the server stores and hands out the sealed files. A change reaches the other machines in about a second, and no machine needs a port open. `parawatch relay setup <url> <folder>` makes a space and prints a code for the other machines, `parawatch relay join <code> <folder>` adds one, and the desktop app keeps the folder in step while it runs (`parawatch relay run` where there is no app). `parawatch relay serve` runs the server; `deploy/relay/` sets one up on Amazon Lightsail with HTTPS. See [The relay](docs/relay.md).
- [The shared folder](docs/protocol.md) describes the files machines exchange and who writes each.
- A Codex session on another machine opens as a conversation too. The log and `codex` stay on that machine: its Parawatch app reads the session and writes the conversation to the shared folder, and a message typed here waits in the shared folder until that machine sends it to Codex and shows the answer, a few seconds later, as the sync tool moves the files. Both machines need this version, and the app has to be running on the machine with the session. Other machines can look at a session without asking; to send it messages, turn on "Messages from other machines" in the settings of the machine it runs on (off by default), since a message runs there without asking, as the session did. A message that takes more than two minutes to get there is not sent.
- Fix: on Windows, stopping a Codex answer left the conversation "working" for good, so it took no more messages. A stopped codex on Windows ends without writing that its turn ended; once the process is gone, the turn now counts as over and the conversation shows that it was stopped.
- The app finds `codex` where the Codex installer for Windows puts it.

## 0.3.15 (2026-11-14)

- Fix: a session running on another machine could not be opened from this one, and on Windows no Claude app session could be opened at all. Parawatch only looked for the Claude app's sessions in the folder of the installer build, while the Microsoft Store build keeps them elsewhere; it now looks in both. When a session has Remote Control on, parawatch passes its link to the other machines, so clicking it there opens it on claude.ai. A subagent opens the session it works under. A session on another machine without Remote Control is no longer shown as a link, and its tooltip names the machine it runs on. The machine running the session needs this version to pass the link on.
- On Windows, `goto` opens links through the system handler, so a link with `&` in it is no longer cut short.
- The app opens Codex sessions and `codex exec` jobs as conversations. Click one on this machine to read what was asked, what Codex answered, the commands it ran (with their output) and the files it changed (with the diff), as Codex writes them. Type below to send it the next message: it runs `codex exec resume` with the sandbox, extra folders and model the session last had, and never waits for an approval, as an `exec` run cannot ask. While Codex answers, the pane shows what it is doing, with a button to stop it. A session that is open in the Codex app or a terminal, or that Codex is already working on, takes no message until it is free. Set `PARAWATCH_CODEX_BIN` when the app cannot find `codex`.

## 0.3.14 (2026-11-13)

- Fix: the app could update twice in a row. Once an update was downloaded, it stopped looking, so a release that came out later was only found after the restart. It now keeps looking while an update is ready, and looks once more right before Restart to Update; when something newer is out, it downloads that and then restarts into it.
- Fix: when two sessions claimed `--role lead` in the same project within the same millisecond, the earlier one stayed lead. The later claim now wins.
- The app has a board: every project at a glance, one line per session, marked as needing you, stopped, running, waiting on others, or quiet, with the cards and pull requests it is stopped on as chips. A button in the title bar switches between the board and the feed (the cards and the agents' chart); from about 1000 pixels wide both show side by side. The summary at the top filters the board, and a card chip goes to the card in the feed.
- On macOS the title bar takes a second line when a narrow window has many counts, instead of spilling over.
- Tests for the command line, the panel and the updater. Windows CI failures now fail the build.

## 0.3.13 (2026-11-13)

- Fix: a session's first wait read the log from the top. A new lead was then woken by every old change on the project's pull requests, also ones merged weeks before (CI results, conflicts). A first wait now starts just before the session first shows in the log: its claim, a card it opened, a pull request linked or handed to it.

## 0.3.12 (2026-11-13)

- Fix: a lead waiting with `wait -p <project>` was woken by every answer and every pull request change in the project, also on cards and pull requests another live session owned and was waiting on itself, and spent a turn each time to say it was not its own. Inside a session, `-p` now only names the project: what another live session owns goes to that session. Outside a session, `-p` still reads everything. A lead that moves to the new rule starts where its project wait stopped.
- Fix: once a session ended with `claim --done`, news on its pull requests that were already merged or closed (bot comments after a merge) woke every session waiting in the project. That news now wakes only the session that owned the pull request; open cards and open pull requests still pass to the project's sessions.
- What no session owns in a project, and what a session that has ended left open, now goes to the project's lead only, instead of waking every session there. A lead is the session that last claimed `--role lead`; one per project.
- With no lead, such answers and pull requests wait in parawatch instead of being lost or waking everyone: `status` lists them under NO SESSION GETS THESE, a card says no session gets its answer yet, and the panel shows them in their own group with a Help button that lists the project's sessions and makes one the lead. The new lead is handed what was waiting and told once of each.
- `parawatch lead <project> <session>` picks a lead from the command line. `parawatch hand <card or PR> <session>` gives a card or a pull request to another session, which is told once, with the card's answer.
- The skill, docs/agents.md and the instruction block say a lead waits with a plain `parawatch wait`, that a session the human started on their own keeps its cards, and what a handed card looks like.

## 0.3.11 (2026-11-13)

- Fix ([#28](https://github.com/penspanic/parawatch/issues/28)): on Windows, `wait` could exit with `EPERM` while Syncthing or a cloud drive replaced another machine's event log, and an agent that did not notice stopped being woken. A log that cannot be opened for a moment is tried again a few times and then read as it was last time; `wait` keeps polling through such errors, and through errors from watching the folder.
- Fix: a subagent that ran `parawatch claim` renamed the session that started it, because a subagent runs with its session's id. The claim now goes to the subagent whose log is running the command, so the lead keeps its own title and task.
- A card's file that is not on this machine yet (a cloud drive or sync tool still bringing it, or a path only the asking machine has) shows as "not on this machine yet" with a dashed outline, instead of failing to open with no reason.

## 0.3.10 (2026-11-12)

- Fix: an app opened from Finder could not find `gh` (Homebrew's folder is not on its `PATH`), and its failed readings counted as fresh, so no process read GitHub and pull request news stopped for every agent. Each process now looks for `gh` in the usual install folders too (or `github.cli` in config.json), a failed reading leaves the last good one in place so a process whose `gh` works reads at once, and while nobody gets through the app shows "GitHub is not being read", `status` says so, and `doctor` names the process that failed and why.
- Fix: a subagent that handed its report back, or that Claude Code marks finished in its meta file, showed as stalled while thinking. It is done.
- Fix: on a card with options, an answer with words but no choice moved the card to answered, and it stayed there after the agent replied and asked for the choice. Once the agent comments, the card is back in what needs you, with the exchange shown on the card, until you choose.
- Fix: a question asked at the end of a turn stayed under asked in chat after the human replied, when the reply was a pasted block or other text the log marks as the human's but not as a typed prompt.
- Fix: a session that searched for the words `gh pr create` (in `grep`, a quoted message, a heredoc) was taken to have opened a pull request, and got any pull request URL in the output, taking it from the session that did open it. Only a command that runs `gh pr create` counts, only the URL it prints on its own line is taken, and such a wrong link gives way to the session that opened the pull request. A link made with `parawatch pr link` stays.
- A session held by a permission prompt shows under needs you as "approve a tool call: <tool>" when the Claude Code hook also handles `PermissionRequest` and `Notification` (see docs/agents.md). Without them, a session stalled on a tool call says a permission prompt may be open.

## 0.3.9 (2026-11-11)

- The desktop app is built on GitHub's machines from a version tag, for macOS and now Windows: an x64 installer (`Parawatch-Setup-<version>.exe`) that updates itself like the macOS app. It is not signed yet, so Windows warns the first time it is opened. A pull request that touches the app builds both, to see the build still works.
- On Windows the app installs for the current user into `%LOCALAPPDATA%\Programs\parawatch`, with a Start menu entry whose app id lets its notifications through.

## 0.3.8 (2026-11-11)

- A card's pictures open in a viewer over the app window instead of another app: the page dims, the picture fits the window, and it zooms with the wheel, a trackpad pinch, a double click or + and - (0 fits), and pans by dragging. The arrows (or ← →) go to the card's other pictures and videos; Esc or a click beside the picture closes it. A video plays in its card as before and has a button at its top right to view it larger. "Open in its own app" stays in the viewer's bar.
- The dismiss button sits in the card's head, beside the fold button, instead of on its corner. It shows while the card is hovered; the first click turns it into a red "Dismiss" in place of the age and id, and a second click within three seconds dismisses.
- The app's settings show the command line's version under the app's, and update it when it is older, with the npm that installed it. With Update the command line too on (the default), an app that has just updated itself brings the command line to its version a little after it starts, so one restart updates both.
- An approved pull request with green CI that GitHub still reports as blocked shows as `merge held` instead of `merge`, and counts as stuck after 8 hours. Something other than reviews and CI holds it: a branch rule, or a merge system outside GitHub with its own approvers. GitHub does not say who.
- A session's pull requests show on its lane in the agents chart, after its cards: `#22 review`, `#23 CI failed`, `#21 held`, in red once stuck. A click goes to the pull request in its section; a right click opens a menu with Open Link and Copy Link, as does the pull request's name in its section. An idle session with nothing else pending says which pull request it waits on and on what, instead of its last summary.
- A click that scrolls to a card or a pull request (a card or pull request chip on a lane) marks where it went: once the scroll stops, a ring pulses twice around the card or row and fades.
- In `status`, a run whose title is cut keeps its `(N PR)` count and repeat count at the end.
- A card's head stays on one line: when it is narrow, who asked is cut short (the whole name is in the tooltip).

## 0.3.7 (2026-11-10)

- Dismiss a card that no longer matters: the round x on the card's corner in the app (click twice), or `parawatch dismiss <card> -n "why"`. The card closes without an answer and shows as dismissed under Closed. The agent that asked gets "dismissed by the human" at its next `wait` or `inbox`.
- Card sections are a colored tile and a count, with what they are in the tooltip. What needs you is in color (a project's cards, asked in chat, reviews); below an hourglass rule, what waits on others is gray (pull requests, answered, closed). Nothing needs you is a green check.
- The counts at the top are chips in their section's color, and a click opens the section and scrolls to it.
- In the agents chart each project has a tinted head row and a rule above it, and the head row's timeline sums all the project's runs, so a folded project still shows when it was busy.

## 0.3.6 (2026-11-10)

- Fix: a Claude Code turn the human stopped showed as working and then stalled, and so did the subagents stopped with it. A stopped session now shows as idle and a stopped subagent as done, both marked "interrupted".

## 0.3.5 (2026-11-10)

- Publishing a GitHub release publishes the CLI to npm from GitHub Actions, with npm trusted publishing and a provenance statement.
- The app shows each card's id in its head (`c58`, or `winpc-c11` for a card from another machine), as agents name it in chat. A click copies it.
- A card folds to its title with the chevron in its head, and stays folded until you open it again.
- The to-do group inside a project opens as a box inside the project. Answered cards are a group of their own, and the to-do, answered and closed groups are named.
- A run that opened a card and has no answer yet shows the card at the end of its timeline, and its line says what it waits on. A click goes to the card.
- The color for a session that asked in chat is a darker mustard that reads as text, and red text has more contrast.

## 0.3.4 (2026-11-10)

- A Claude Code run that ended its turn while a background job it started is still running shows as working, with the job's command, instead of done or idle. It counts as stalled only when both its log and the job's output file have been quiet for 20 minutes, so a job that hung shows up instead of dropping out of the list. A `parawatch wait` or `parawatch watch` in the background does not count: that session is waiting for the human.
- A lead that has really ended (it said `claim --done`, or it was archived in the Claude desktop app) leaves the list 30 minutes after its last activity, like other runs. An idle lead still stays.
- Hide a run: the eye button on a run row in the app, or `parawatch run hide <id>`. It stays hidden on every machine until it does something new. `parawatch run unhide <id>` brings it back, and `runs --all` shows hidden runs.
- Approval cards: the preview is folded to a few lines with Show all, a Markdown preview renders without its frontmatter, and a chip opens the preview file itself. The action shows its first line, with the whole text under details.
- `parawatch edit` can change `--action`, `--preview` and `--attach` (`--no-attach` clears) while nobody has answered the card. The card shows when the action or preview changed. After an answer, open a new card instead.
- The desktop app shows each service's own icon (Claude Code, Codex, GitHub) beside runs, pull requests and the card's asker. The icon is fetched from the service's site, as a browser shows it, and cached for a week; no logo files ship with parawatch. Turn it off in Settings with "Show service icons".

## 0.3.3 (2026-11-10)

- Folders are compared by their real spelling: symlinks and Windows short names are resolved, and on Windows case and `/` against `\` no longer matter. A run in a worktree reached through a link, or on Windows, finds its project, and so does the Claude Code hook.
- The test suite passes on Windows.
- A Claude Code session archived in the Claude desktop app shows as done, with its subagents. One archived in the middle of a turn used to show as stalled for hours.
- Cards and pull requests of a session that has ended (it said `claim --done`, or it was archived in the Claude desktop app) belong to its project again: an answer reaches the other sessions waiting in that project, as for a card no session owns. Before, it reached only a wait on the whole project (`wait -p`). The card in `status` and the app counts those waits.
- `claim --done` also ends a session that shows as stalled, not only an idle one.
- `runs` and `status` show the machine a run is on in a column of its own. It used to follow the title and was cut off with it at most terminal widths.
- The settings screen has a Back control with a chevron at the leading edge of its header instead of a close button on the right. Esc still goes back.
- Restart to Update now says "Installing 0.x.y. Parawatch reopens in about 30 seconds." before it quits, because the install takes about half a minute with nothing on screen. Opening Parawatch again during that time used to make the update fail; it now tells you the install is still going and closes itself so the update can finish.
- If an update was downloaded but the restart never finished, Parawatch says so the next time it starts and offers Restart to Update again, in settings and in the menus.
- Fix: a path to open or attach that is absolute on the other system was rooted on this one: `/Users/Shared/...` became `E:\Users\Shared\...` on Windows, and `C:\...` became `<folder>/C:\...` on a Mac. A path absolute on either system is now kept as written, so a card opened on the PC can name an app on the Mac. In Git Bash, use `MSYS_NO_PATHCONV=1`.

## 0.3.2 (2026-11-10)

- `wait` and `inbox` run from an agent session read only that session's news: answers on cards it opened, news on pull requests linked to it, and cards or pull requests no session owns in the project it claimed. Each session reads with a cursor of its own, so sessions in one project no longer wake for each other's pull requests or take each other's news. A session that used to wait with `-p` starts where that wait stopped.
- `wait -p <project>` still reads the whole project, for a lead. Outside an agent session nothing changes.
- The instruction block (`parawatch init`) and the skill now say `parawatch wait`. `doctor` reports an older block as outdated; run `parawatch init` again to update it.
- The Claude Code hook reports only the session's own unhandled news.
- Fix: a machine reading GitHub for the first time in a while wrote again the pull request news another machine had already reported, and every wait woke a second time. News another machine wrote since this machine last read GitHub is now left out.
- Runs on another machine show in `runs`, `status` and the app, marked with the machine. Each machine writes a summary of its sessions to `runs/<device>.json` in the shared folder about every half minute while `status`, a `wait` or the app runs; the agent logs stay where they are. A summary older than 15 minutes is left out. Claims made on any machine apply to those runs.

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
