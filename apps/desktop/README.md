# Parawatch desktop

The [parawatch](../../README.md) panel in its own window. It is used daily on macOS. The code has Windows and Linux paths, but nobody has built or run it there yet.

- **Needs you**: every open card, one collapsible section per project, its kind shown as an icon. Pick an option, write a note, press the check (Done or Looks good) or send; paste or drop a screenshot to attach it. Your answer wakes the agent waiting on that card.
- **To do**: cards that only you can do but nothing waits on. They fold at the end of their project, do not count toward the badge and never notify.
- **Who asked**: click the name on a card to open that agent's session in the Claude desktop app, with a line about the card on your clipboard to paste there.
- **Agents**: a chart at the top, one lane per observed session, subagent and `codex exec` job, grouped by project. Each lane shows the minutes of the last hour the agent was active, with now at the right edge; the lane of an agent working right now ends in the accent colour. Click its head to fold the chart into one line of counts.
- **Status row**: what needs you, what is left to do and how many agents work, as icons with numbers (hover for words). On macOS it is the title bar.
- **Answered and closed cards**: answered cards wait under the hourglass until the agent picks them up; the newest closed cards stay in a folded group at the end. Click one to read it again and open its builds, videos and pictures.
- **Pictures, videos and files**: shown at their own shape in rows that fill the card. Right click one for the system's file menu: Open, Quick Look, Show in Finder, Copy Path, Share.
- **Settings**: the button at the end of the status row, ⌘, or Settings… in the menu bar menu. Appearance (match the system, light, dark), notifications, open at login, how far back the agents list reaches, and how many closed cards to keep (none, 10, 20 or 50).
- **Menu bar and dock**: the menu bar icon shows how many cards need you: the signal dot grows into an amber bubble with the number in it. It moves: the dots travel along their lanes while agents work. It stays still when nothing happens, or when the system asks for reduced motion; the dock icon carries the same number as a badge (a red dot on the taskbar on Windows). Closing the window keeps the app in the menu bar; Quit is in the menu bar menu.
- **Notifications**: a new card that needs you, and a declared job that failed. Click one to open the card. Turn them off in Settings.
- **Open at login**, in Settings. Started at login, the app waits in the menu bar without opening its window.

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

macOS builds are signed ad hoc by default. An ad hoc build runs on the machine that built it, but macOS gives it no notification permission, so alerts fall back to the system notifier and cannot open the card. Sign the build with a certificate from your keychain to get real notifications: `npx electron-builder --config builder.json --dir -c.mac.identity="Your Name (TEAMID)"`. The first card then makes macOS ask whether Parawatch may send notifications. Allow them, with badges on (System Settings → Notifications → Parawatch): once the app has asked, macOS hides the dock badge until you do. To hand the app to someone else, sign it with a Developer ID and notarize it.

### Releases

`npm run release:mac -w @parawatch/desktop` builds the app for Apple silicon and Intel, signs it with `MAC_IDENTITY`, notarizes it with the `notarytool` keychain profile named by `NOTARY_PROFILE`, and uploads the two DMGs to a draft GitHub release for the version in `package.json`, with that version's CHANGELOG section as notes. See the top of [`scripts/release-mac.sh`](scripts/release-mac.sh) for the one-time setup.

The macOS app icon is an Icon Composer document, [`icon/Parawatch.icon`](icon/Parawatch.icon): SVG layers and a JSON description, so the system renders it as Liquid Glass with its light, dark, clear and tinted looks. electron-builder compiles it with Xcode's `actool` (Xcode 26 or later). Edit it in Icon Composer, which comes with Xcode.

The other icons are drawn in code ([`src/art.ts`](src/art.ts)) with the same layout: the menu bar icon and its animation, the taskbar dot, and a flat app icon. `npm run icon -w @parawatch/desktop` writes `build/icon.png` for the Windows and Linux packages: rendered from `Parawatch.icon` by Icon Composer's `ictool` on a Mac with Xcode, otherwise the flat one.

## Layout

| | |
|--|--|
| `src/main.ts` | Window, menu bar, badge, notifications, and the bridge to the store |
| `src/preload.ts` | The small API the page gets on `window.parawatch` |
| `src/renderer.ts` | The page: the shared panel from [`packages/panel`](../../packages/panel), Markdown, toasts |
| `src/settingsView.ts` | The settings screen |
| `src/prefs.ts` | The settings and the values each may take, shared by the window and the app |
| `src/rules.ts` | What counts toward the badge and what deserves a notification |
| `src/art.ts` | App, menu bar and overlay icons, and a small PNG encoder |
