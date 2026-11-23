# On more than one machine

`parawatch guide machines` prints this page for the installed version.

When `parawatch sync` shows other machines, the human may answer from any of them. Nothing changes in how you ask or wait. Ids then carry the machine (`pc-c3`); use the id the command printed. Attach files under your home folder or the shared folder (or a folder named with `parawatch sync root`), so the human's machine can open them. An app path given to `try --open` only opens on the machine that has it, so say in the body which machine to try it on.

## Keeping parawatch up to date

When `parawatch doctor` or `status` says the desktop app is older, run `parawatch app update` yourself on that machine; do not ask the human to press Restart to Update. The app restarts (about half a minute with no window) and then brings the command line to its version. The command ends when the new version runs.
