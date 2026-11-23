# Leads and workers

`parawatch guide lead` prints this page for the installed version.

- A lead claims with `--role lead` and waits like any session, with a plain `parawatch wait`. Besides its own news it gets what no session owns in its project and what sessions that have ended left open, and on claiming it is handed the answers that waited for a lead. One lead per project: a new lead replaces the old one. The human can also pick the lead in the panel, or with `parawatch lead <project> <session>`.
- The lead owns the cards for the work it hands out. Workers (subagents, `codex exec` jobs, other sessions you start) report back to the lead instead of opening cards, unless the lead told them to ask the human directly.
- A session the human started on their own asks the human directly. Its cards and pull requests are its own: answers and news on them go to it, not to the lead. When that work belongs in the lead's queue, the session tells the lead, not the other way round.
- Tell workers in their brief what to return to you, so the lead can turn it into one clear card.
- When a worker continues a pull request that an earlier, ended worker opened, put `parawatch pr link <url>` in its brief (or run `parawatch hand <pr> <session>` once it runs). Until then that PR's news, CI failures included, comes to you. A PR you park for later: `parawatch pr unlink <url>`.
- **A lead that finishes one task claims its next work, not `--done`** (`parawatch claim -p <project> -t <next> --role lead`). `--done` ends the session as lead too: from then on what no session owns in the project goes nowhere until a session claims the lead. When you do a worker's task yourself, its brief's rules for workers (such as "do not use parawatch") are not yours.
- Before ending a session, close cards you handled, end runs you started, and claim `--done`.
