# More than one machine

Agents on a second machine (a desktop PC, a build box) can ask and be answered like the ones on your laptop. Parawatch does not move files between machines itself: point it at a folder that something else keeps in step, and each machine writes only its own log there. Or run a [relay](relay.md), a small server of your own that carries the folder sealed end to end. What the folder holds is in [The shared folder](protocol.md).

```sh
# on each machine, once, with its own name
parawatch sync setup ~/agent-sync/parawatch --device mac --adapter syncthing
parawatch sync setup ~/agent-sync/parawatch --device pc  --adapter syncthing
parawatch sync            # this machine, the others, how the sync tool is doing
```

- **Nothing moves until you run `sync setup`.** A machine on its own keeps today's single file and format.
- **`sync setup` moves this machine's log into the folder.** It becomes `events/<device>.jsonl` with every event, id and seq as it was, so cursors and open cards carry on. The old file is kept beside it as `events.jsonl.before-sync`. A copy of parawatch older than 0.3 on that machine stops writing until it is updated.
- **Each machine reads every log and writes only its own.** The logs merge in time order. Two machines never write one file, so a sync tool has nothing to merge.
- **Ids carry the machine once a log is shared:** `pc-c3`, `mac-r2`. Commands take the short form (`parawatch close c3`) while only one machine has that number. Cards from before the move keep their ids.
- **When two machines answer one card before either has seen the other's answer, the earlier answer stands.** The other one stays on the card, marked as not used, and does not wake the agent. An answer given after seeing the first one counts as usual.
- **Paths follow the machine.** Attachments, things to open and project folders written on another machine are read as the same place here, under its home folder or the shared folder. Name other folders that sit in different places on each machine (a cloud drive, say): `parawatch sync root gdrive "G:\My Drive"` on one machine and `parawatch sync root gdrive ~/Library/CloudStorage/…/My\ Drive` on the other. Pasted pictures are saved in the shared folder, so every machine can open them.
- **A path that is absolute on either system is kept as written**, so an agent on the PC can ask you to open `/Users/Shared/Try/Game.app` on the Mac. Git Bash on Windows rewrites arguments that start with `/` before parawatch sees them; run such commands there with `MSYS_NO_PATHCONV=1`.
- **Waits are seen everywhere.** A card on your laptop says whether an agent on the PC is waiting for it.
- **Runs are seen everywhere.** Each machine writes a summary of the sessions its agent logs show (state, title, project, last activity, what each does) to `runs/<device>.json` about every half minute while `status`, a `wait` or the app runs. The other machines show those runs marked with the machine. The logs stay where they are. A machine whose summary is older than 15 minutes drops out of the list.
- **Every machine reads GitHub for itself.** The same news is delivered once.
- **Cards reach you as far as the sync tool does.** With Syncthing, leave global discovery and relays on (its defaults) to stay in step from another network; with them off, machines only meet on the same network or a VPN. `parawatch sync` shows each connection's address, a relay included.

The shared folder holds `events/`, `devices/` (each machine's paths, version and last sign of life), `runs/`, `listeners/` and `attachments/`. Cursors, the lock, the GitHub reading and settings stay on each machine.

**Sync adapters** are how parawatch asks the sync tool how it is doing, for `parawatch sync`, `doctor` and the app's settings. Pick one with `--adapter` (or `"sync": { "adapter": … }` in `config.json`):

| Adapter | Reports |
|---|---|
| `syncthing` | Asks the local Syncthing through its REST API (address and API key from its `config.xml`; `PARAWATCH_SYNCTHING_KEY` or `"sync": { "syncthing": { "url", "home" } }` override): connected devices, when the folder was last in step, files on the way, errors. |
| `folder` | Anything else that keeps a folder in step (a cloud drive, a network share): the other machines' last writes and conflict copies. |
| `relay` | A [parawatch relay](relay.md), which carries the folder itself, sealed end to end: whether the server answers, when the folder was last in step, files still on their way. Set up with `parawatch relay setup` or `relay join`, not `sync setup`. |

An adapter is one object with a `status()` method (`src/core/sync.ts`, `registerAdapter`). Another tool, such as a git checkout or a small server, fits the same shape.
