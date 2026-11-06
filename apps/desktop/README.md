# Parawatch desktop

The [parawatch](../../README.md) panel in its own window, for macOS, Windows and Linux.

- **Needs you**: every open card, one collapsible section per project. Pick an option, write a note, press Done or Looks good; paste or drop a screenshot to attach it. Your answer wakes the agent waiting on that card.
- **To do**: cards that only you can do but nothing waits on. They fold at the end of their project, do not count toward the badge and never notify.
- **Who asked**: click the name on a card to open that agent's session in the Claude desktop app, with a line about the card on your clipboard to paste there.
- **Agents**: every observed session, subagent and `codex exec` job, grouped by project.
- **Menu bar and dock**: the menu bar icon shows how many cards need you (macOS shows the number next to it); the dock icon carries the same number as a badge (a red dot on the taskbar on Windows). Closing the window keeps the app in the menu bar; Quit is in the menu bar menu.
- **Notifications**: a new card that needs you, and a declared job that failed. Click one to open the card. Turn them off from the menu bar menu.
- **Open at login**, from the menu bar menu. Started at login, the app waits in the menu bar without opening its window.

The app reads and writes the same store as the CLI (`~/.local/state/parawatch`, or `$PARAWATCH_HOME`) using the CLI's own code, so it does not need the CLI on `PATH`. Agents still use the CLI. While the app runs, the CLI leaves notifications to it.

## Run from source

```
npm install
npm start -w @parawatch/desktop
```

## Build

```
npm run dist -w @parawatch/desktop       # installers in apps/desktop/release
npm run dist:dir -w @parawatch/desktop   # just the app folder, quicker
```

macOS builds are signed ad hoc, which is enough on the machine that built them. To hand the app to someone else, sign it with a Developer ID and notarize it (set `CSC_NAME` and the notarization variables electron-builder documents). The first time it runs, macOS asks whether Parawatch may send notifications; until you allow them, alerts go through the system notifier and cannot open the card.

The icons are drawn in code ([`src/art.ts`](src/art.ts)); `npm run icon -w @parawatch/desktop` writes `build/icon.png` for the installers.

## Layout

| | |
|--|--|
| `src/main.ts` | Window, menu bar, badge, notifications, and the bridge to the store |
| `src/preload.ts` | The small API the page gets on `window.parawatch` |
| `src/renderer.ts` | The page: the shared panel from [`packages/panel`](../../packages/panel), Markdown, toasts |
| `src/rules.ts` | What counts toward the badge and what deserves a notification |
| `src/art.ts` | App, menu bar and overlay icons, and a small PNG encoder |
