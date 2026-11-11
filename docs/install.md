# Installing, updating, removing

There are three parts. Most people want all three.

**The CLI**, which agents and you use:

```
npm install -g parawatch
```

**The agent skill**, so Claude Code and Codex agents learn the protocol on their own:

```
parawatch skill install
```

It links [`skills/parawatch`](../skills/parawatch/SKILL.md) into `~/.claude/skills` and `~/.codex/skills`. The installed skill is a link to the copy in the package, so updating parawatch updates the skill.

**The desktop app**, to see and answer cards without a terminal. Download it from the [latest release](https://github.com/penspanic/parawatch/releases/latest).

- **macOS**: the DMG, `arm64` for Apple silicon, `x64` for Intel. It is signed and notarized, so it opens without warnings.
- **Windows** (from 0.3.9): `Parawatch-Setup-<version>.exe`, for x64. It installs for your user only, into `%LOCALAPPDATA%\Programs\parawatch`, with a Start menu entry, and waits in the notification area (under ^ until you pin it). It is not signed, so SmartScreen warns the first time it runs: More info > Run anyway.

Both update themselves: they download a new version in the background and ask you to restart (Check for Updates in the menu bar or tray menu, or Settings > Update automatically). On Linux, [build it from source](../apps/desktop/README.md#run-from-source).

**Checking the setup.** `parawatch doctor` shows the versions of the CLI and the app and whether they differ, the store, the skill links, the instruction files in this folder, the hook, and GitHub, with what to run for anything that needs work. Paste it into bug reports. `status` also says, at its end, when a newer CLI is out or when the app and the CLI are different versions.

### Updating and removing

```
npm install -g parawatch@latest     # the CLI; the linked skill follows it
```

The CLI asks the npm registry for the latest version at most once a day, only when you run `status` or `doctor` at a terminal. `"updates": { "check": false }` in `config.json` or `PARAWATCH_UPDATE_CHECK=0` turns that off; it is off in CI. The app looks at GitHub Releases every few hours unless you turn Update automatically off.

The app also keeps the CLI at its own version. Settings shows the CLI's version under the app's; when the CLI is older, Update installs the app's version with the npm that installed the CLI (`<prefix>/bin/npm install -g --prefix <prefix> parawatch@<version>`). With Update the command line too on (the default), a newly updated app does this by itself a little after it starts, so one restart updates both. A CLI installed some other way, such as a linked checkout, is left alone and the row says where it is.

To remove parawatch:

```
parawatch skill uninstall           # the skill links
parawatch init --remove -f AGENTS.md   # the block in each instruction file you added it to
npm uninstall -g parawatch
```

Take the `parawatch hook` lines out of your Claude Code settings if you added them, remove the app (on macOS drag Parawatch.app to the Trash; on Windows uninstall Parawatch in Settings > Apps), and delete `~/.local/state/parawatch` (your cards and history) and the app's logs (`~/Library/Logs/Parawatch`, or `%APPDATA%\Parawatch` on Windows) if you want those gone too.
