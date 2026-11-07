# Security

parawatch runs only on your machine. It has no server and makes no network requests. It reads agent logs under your home folder, never writes to them, and keeps its own state in `~/.local/state/parawatch` (or `$PARAWATCH_HOME`). Cards can hold paths and links that the desktop app and plugin open when you click them.

## Reporting a vulnerability

Please report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for it.

Include what you found, how to reproduce it, and which version or commit you used. You will get a reply within a week.

## Supported versions

Only the latest release gets fixes.
