# Writing a good card

`parawatch guide cards` prints this page for the installed version.

One question per card. Pick the kind by what the human has to do:

| Need | Command |
|--|--|
| A choice | `parawatch ask -p <project> "<the question>" -o "<option>" -o "<option>" -r <n> -b "<why it matters now>"` |
| Approval of a step you have prepared (merge, post, move a ticket, send a message, force-push) | `parawatch ask -p <project> "<what and why, as a question>" --action "<the exact command or step>" --preview <file with the text it sends>` |
| An open answer | `parawatch ask -p <project> "<the question>" -b "<context>"` |
| Try a build, watch a video, look at a screen | `parawatch try -p <project> "<what to try>" --open <app, file or URL> --attach "<caption>=<image or video>" -l "<what to look at>"` |
| Something only they can do, and you are stuck until they do | `parawatch block -p <project> "<what to do>" -b "<exact steps>"` |
| Something only they can do, but nothing waits on it now | `parawatch todo -p <project> "<what to do>" -b "<exact steps, and by when>"` |

`block` and `todo` take no choices; a choice is always `ask`.

## The card

- **The title is the question or the request**, readable alone in a list: "Ship the top-box ending?" not "Ending".
- **The body is two or three lines**: what changed, what it affects, what happens if they do not answer. It renders as Markdown.
- **Write in the human's words**: what they will see or feel in the product, not ticket numbers, metrics, engine terms or internal ids. Put those in an attachment or a link at the end of the body.
- **Options are exclusive and concrete, and each says what happens if picked.** Recommend one with `-r` when you have a view; say why in the body.
- **`-l` on a `try` card is one short line: where to look.** Several things to check go in the body as a numbered list, one item per line, so they read as a list in the panel.
- **Pictures and videos carry captions**, and pictures of one choice are tied to it: see `parawatch guide attachments`. Do not point at pictures by their place in the body.
- **`--open` takes what they should launch** (an `.app`, a file, a URL), never a command: parawatch does not run it and refuses one. A command to run goes in the body as a code block, which the human can copy.
- **Add `-t <task>`** when the project runs several tasks at once, so the human can tell them apart.
- **`block` is red and counts as needing them now.** Use it only when your work stops until they act. Errands for later (a bill, a registration, a policy check, a measurement whenever the machine is free) are `todo`; they wait folded in the panel and do not pop up.
- **Moving items from a board or a note:** pass `--since <YYYY-MM-DD>` with the date the item first came up, so the card does not look new. `parawatch edit <card>` fixes a card's kind, wording or date later.

## Approvals

- **`--action` is the exact command, one line if possible.** Steps and reasons go in the body, and `--preview` is the file with the text it sends (the human can open that file from the card). Change `--action`, `--preview` or `--attach` with `parawatch edit` while the card is unanswered; once answered, close it and open a new one.
- **An approval shows exactly what runs.** With `--action` the human sees the command and the preview and answers Do it or Don't, without opening your session. Run exactly that on yes; say in the close note that you ran it.

## What not to do

- **Never leave a question only in your reply.** If your turn ends needing the human, the question goes on a card. Parawatch flags questions it finds at the end of a turn as "asked in chat, no card", but that is a guess and easy to miss.
- Do not open a card for something you can decide yourself, or that the project's own rules already settle.
- Never answer a card yourself: `answer` is the human's. To add information without waking anyone: `parawatch comment <card> "<text>"`.
