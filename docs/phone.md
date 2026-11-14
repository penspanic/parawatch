# On a phone

`apps/web` is the panel as a web app for a phone. It reads your machines' shared folder through a [relay](relay.md), so it needs one: Syncthing and cloud drives do not reach a phone.

What it does:

- **Shows what the machines show:** the cards that need you, the agents by project with the last hour of activity, and who waits on what.
- **Answers cards:** pick an option, write a note, mark done, or dismiss. The answer reaches the waiting agent like one given on a machine.
- **Hides runs**, until they do something new.
- **Opens a Claude session** through its Remote Control link, when the session has one.
- **Shows pictures cards carry** when they are in the shared folder (a picture pasted into an answer is); files elsewhere on a machine show by name.

Opening files and apps, attaching pictures and Codex conversations are for the machines. There are no notifications yet.

## Pairing

On a machine that uses the relay:

```sh
parawatch relay code
```

Open the app on the phone, paste the code and give the phone a name (`phone`). The code holds the key to your folder: it is kept on the phone only (in the browser's storage for the site) and never sent to the server. A link `https://<app>/#join=<code>` fills it in; the part after `#` is not sent anywhere either. "Unpair this phone" removes it.

On an iPhone, add the page to the home screen (Share, Add to Home Screen) and pair from there: the home screen app keeps its own storage, apart from Safari.

## How it reads the folder

The phone keeps no copy of the folder. It reads the files that make the picture and writes its own:

- **Reads** every machine's `events/<device>.jsonl`, `runs/<device>.json`, `devices/<device>.json` and the `listeners/` files, through the relay, and follows the relay's change list while the app is open.
- **Writes** `events/<phone>.jsonl` (its answers, in the same format as a machine's log) and `devices/<phone>.json` (`platform: "web"`, no paths).

The relay knows files only by a keyed hash of their path, so the phone learns which file is which by computing the names of the paths it expects (`events/mac.jsonl` for a machine called `mac`) and by opening the small files once (a device file is a few hundred bytes). Pictures are opened only when a card shows them. The sealing is the same as the machines', with the browser's Web Crypto.

## Running it

```sh
npm run build -w @parawatch/web   # apps/web/dist: static files
```

Serve `dist/` over HTTPS from any static host. The relay has to let the app's origin call it (CORS); `deploy/relay/setup.sh` with `APP_DOMAIN=<app domain>` serves both from one server, with Caddy:

```sh
RELAY_DOMAIN=relay.example.com APP_DOMAIN=app.example.com RELAY_INVITE=<secret> bash setup.sh
scp -r apps/web/dist/* <server>:/var/www/parawatch-web/
```
