# Storage

Everything lives in one append-only file, `~/.local/state/parawatch/events.jsonl` (`$PARAWATCH_HOME`, or `$XDG_STATE_HOME/parawatch`). Writers take a short lock, so several agents can write at once. Next to it: cursors in `cursors/`, running waits in `listeners/`, the last GitHub reading in `github.json`, the last update check in `update.json`, the version each copy (CLI, app) last ran in `clients/`, and the optional `config.json`. Delete the folder to start over. A shared log lives in the shared folder instead; see [More than one machine](sync.md).

Every event carries a format number. A copy of parawatch reads a log that a newer copy wrote, skipping what it does not know, but refuses to write to it and says to update. The desktop app's own log is in `~/Library/Logs/Parawatch/main.log` (Help > Show Log File).

Desktop notifications for new cards use `osascript` on macOS and `notify-send` on Linux. `PARAWATCH_NOTIFY=0` turns them off. While the desktop app runs it notifies instead, and the CLI stays quiet. To-dos never notify.
