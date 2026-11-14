# The relay

A small server that carries the [shared folder](protocol.md) between your machines in place of a sync tool. Machines only make outgoing HTTPS requests to it, so nothing needs a port open or a VPN, and a change reaches the other machines in about a second.

**The server cannot read what it carries.** Each machine seals every file, path included, with AES-256-GCM under a key that never leaves your machines, and the server knows a file only by a keyed hash of its path. It sees how many files a space has, their sizes and when they change.

## Using one

```sh
# first machine: make a space and share this machine's folder through it
parawatch relay setup https://relay.example.com ~/agent-sync/parawatch --device mac --invite <the server's invite>

# it prints a code (pwr1....); on each other machine:
parawatch relay join <code> ~/agent-sync/parawatch --device pc
```

- **The code holds the space, its token and the key.** Anyone with it can read and write your space. Move it between your own machines by hand. `parawatch relay code` prints it again.
- **The desktop app keeps the folder in step while it runs.** On a machine without the app (a build box), run `parawatch relay run`, as a service if it should always run. Only one runs at a time: `relay run` refuses while the app keeps the folder, and the app leaves it to a `relay run` that is already going.
- **Moving from Syncthing:** run `relay setup` or `relay join` with the folder you already share. The first run takes what is on the relay, then sends up the rest. Then stop Syncthing for that folder, so two carriers do not both move it.
- **Files over 200 MB stay on their machine** (a long screen recording, say). `parawatch sync` shows how the relay is doing, as it does for other carriers.

## Running a server

The server is part of the `parawatch` package and has no other dependencies:

```sh
PARAWATCH_RELAY_INVITE=<a long random string> parawatch relay serve --port 8787 --data /var/lib/parawatch-relay
```

- It listens on `127.0.0.1:8787` by default. Put a proxy that ends HTTPS in front of it (Caddy, nginx). The token and the sealed files must not travel in clear text.
- **The invite is what it takes to make a space.** Give it only to people you want on your server. Without `PARAWATCH_RELAY_INVITE` no new space can be made; existing ones keep working.
- **What it keeps:** each space in its own folder under `--data`: `space.json` (a hash of its token), `journal.jsonl` (which sealed file changed when) and `files/` (the sealed files). Back up that folder to keep the spaces.

`deploy/relay/` has a script that sets this up on an Amazon Lightsail instance with Caddy and a domain of yours.

## API

Every call but making a space carries `Authorization: Bearer <space token>`.

| Call | Does |
|--|--|
| `POST /v1/spaces` (invite as the bearer) | Makes a space: `{ space, token }`. |
| `GET /v1/spaces/:space/changes?after=N&wait=S` | Files changed after change `N`: `{ head, changes: [{ name, seq, size?, deleted? }] }`. With `wait`, holds the request up to `S` seconds (at most 30) until something changes. |
| `PUT /v1/spaces/:space/files/:name` | Stores a sealed file (up to 256 MB): `{ seq }`. |
| `GET /v1/spaces/:space/files/:name` | The sealed file. |
| `DELETE /v1/spaces/:space/files/:name` | Forgets it: `{ seq }`. |
| `GET /healthz` | `{ ok: true }`. |

A sealed file is `0x01`, a 12-byte nonce, the 16-byte GCM tag, then the encrypted body: the path's length (4 bytes, big-endian), the path, the bytes. `name` is the first 40 hex digits of HMAC-SHA256 of the path. Both keys come from the space key by HKDF-SHA256 (`src/core/relay.ts`).
