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

**The desktop app**, to see and answer cards without a terminal. On macOS, download the DMG from the [latest release](https://github.com/penspanic/parawatch/releases/latest): `arm64` for Apple silicon, `x64` for Intel. It is signed and notarized, so it opens without warnings. From 0.2.1 on it updates itself: it downloads a new version in the background and asks you to restart (Parawatch > Check for Updates, or Settings > Update automatically). Elsewhere, [build it from source](../apps/desktop/README.md#run-from-source).

**Checking the setup.** `parawatch doctor` shows the versions of the CLI and the app and whether they differ, the store, the skill links, the instruction files in this folder, the hook, and GitHub, with what to run for anything that needs work. Paste it into bug reports. `status` also says, at its end, when a newer CLI is out or when the app and the CLI are different versions.

### Updating and removing

```
npm install -g parawatch@latest     # the CLI; the linked skill follows it
```

The CLI asks the npm registry for the latest version at most once a day, only when you run `status` or `doctor` at a terminal. `"updates": { "check": false }` in `config.json` or `PARAWATCH_UPDATE_CHECK=0` turns that off; it is off in CI. The app looks at GitHub Releases every few hours unless you turn Update automatically off.

To remove parawatch:

```
parawatch skill uninstall           # the skill links
parawatch init --remove -f AGENTS.md   # the block in each instruction file you added it to
npm uninstall -g parawatch
```

Take the `parawatch hook` lines out of your Claude Code settings if you added them, drag Parawatch.app to the Trash, and delete `~/.local/state/parawatch` (your cards and history) and `~/Library/Logs/Parawatch` if you want those gone too.
