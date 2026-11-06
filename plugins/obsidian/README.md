# Parawatch for Obsidian

A side panel for [parawatch](../../README.md): what needs you, what your agents are doing, and buttons to answer them. It runs the `parawatch` CLI and keeps no state of its own.

- **Needs you**: every open card. Pick an option, write a note, press Done or Looks good. Paste or drop a screenshot to attach it. Your answer goes through `parawatch answer`, which wakes the agent waiting on that card.
- **Waiting for the agent**: cards you answered that the agent has not closed yet.
- **Agents**: every observed session, subagent and `codex exec` job, grouped by project, with what each is doing right now. Finished subagents fold into a count; click to expand.
- A status bar item shows how many cards wait for you, and a notice pops up when an agent asks something.

Desktop only. It needs the CLI installed (`npm install -g parawatch`).

## Install from source

```
npm install
PARAWATCH_OBSIDIAN_PLUGIN_DIR="<vault>/.obsidian/plugins/parawatch" npm run build -w @parawatch/obsidian
```

The build copies `main.js`, `manifest.json` and `styles.css` into that folder. Obsidian does not load a plugin folder that is a symlink, so copy rather than link. Then enable **Parawatch** under Settings → Community plugins, or reload Obsidian if it is already enabled.

## Settings

| | |
|--|--|
| parawatch binary | Empty looks in `/opt/homebrew/bin`, `/usr/local/bin` and a few other places. Apps started from the Dock do not get your shell's `PATH`. |
| Refresh while open | Seconds between updates while the panel is visible. Card changes arrive right away through `parawatch watch`. |
| Agent history | Hours of agent activity to show. |
| Notify on new cards | An Obsidian notice when a card opens. |

## Working on the panel

`npm run harness -w @parawatch/obsidian` builds `harness/out/`, a plain page that renders the panel with sample cards and logs answers instead of sending them. Serve that folder with any static server. Put a `parawatch status --json` dump in `harness/snapshot.json` and add `?real` to the URL to see your own agents; add `?theme=dark` for the dark theme.
