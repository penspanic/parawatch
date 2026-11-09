# Security

parawatch runs only on your machine. It has no server. Its only network requests are reading your pull requests through your own `gh`, and checking for a new version (the CLI asks the npm registry at most once a day, the app asks GitHub Releases every few hours); both send nothing about you and can be turned off. It reads agent logs under your home folder, never writes to them, and keeps its own state in `~/.local/state/parawatch` (or `$PARAWATCH_HOME`). Cards can hold paths and links that the desktop app and plugin open when you click them.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for it.

Include what you found, how to reproduce it, and which version or commit you used. You will get a reply within a week.

## Supported versions

Only the latest release gets fixes.
