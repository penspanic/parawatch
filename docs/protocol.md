# The shared folder

What machines exchange when they share a log ([More than one machine](sync.md)). Whatever carries the folder (Syncthing, a cloud drive, the [relay](relay.md)) moves these files and nothing else, so a new client (a phone, another tool) talks parawatch by reading and writing them.

## The one rule

**Every file has exactly one writer**, named in its path. Machines read everyone's files and write only their own, so a carrier never has two versions of one file to merge. Writers replace a file by writing a temporary file beside it (a name starting with `.`, or ending in `.tmp`) and renaming it over the old one; carriers skip such files.

Device names are `a-z`, `0-9` and `-`, up to 32 characters (`mac`, `winpc`).

## Files

| Path | Writer | What it holds |
|--|--|--|
| `events/<device>.jsonl` | that device | Its log: one JSON event per line, appended. Every line has `v` (format), `seq` (order within this log), `ts` and `type`: `card.open`, `card.answer`, `card.close`, `run.claim`, `pr.change` and the rest in `src/core/types.ts` (`EventBody`). Readers merge all logs in time order. A line cut short by a carrier is skipped until it is whole. |
| `devices/<device>.json` | that device | Its name, platform, home and shared folder paths (to map paths between machines), named roots, version and last sign of life. |
| `runs/<device>.json` | that device | `{ v, device, at, runs }`: what its agents are doing, rewritten about every 30 s while parawatch runs there. Older than 15 minutes counts as gone. |
| `listeners/<device>-<pid>.json` | that device | A `wait` running there, with a beat every minute; three minutes without one counts as gone. |
| `attachments/…` | the device that saved it | Pictures pasted into an answer, under a name no other machine writes. |
| `chats/<viewer>/watching.json` | the viewer | `{ v, device, at, open: [{ host, id }] }`: Codex sessions of other machines open there, rewritten every 20 s while any is. |
| `chats/<viewer>/asks.jsonl` | the viewer | Messages and stops for those sessions: `{ id, at, host, session, op: "send" \| "stop", text? }`. An id starts with the viewer's name; asks older than ten minutes are dropped when the file is rewritten. |
| `chats/<host>/<session>.json` | the host | `{ v, host, id, at, state, asks }`: the conversation as the host reads it (the latest 150 items) and what became of each ask. Rewritten when it changes and every 30 s while watched; removed when nobody watches. |

Cursors, the lock, the GitHub reading and settings stay on each machine, outside the folder.

## Times

A machine counts another as gone by the age of what it last wrote (`at`, `beat`), not by the carrier. Clocks are assumed to be within a few seconds of each other.
