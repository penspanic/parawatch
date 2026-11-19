#!/usr/bin/env bash
# Sets up a parawatch relay on an Ubuntu 24.04 server: Node, parawatch, a service user, a systemd
# service and Caddy in front for HTTPS. Run as root. It is safe to run again: the Deploy workflow
# runs it on every release to bring the server to the version and settings in this file. The spaces
# are kept, and the relay restarts only when something it runs with changed.
#
#   RELAY_DOMAIN=relay.example.com RELAY_INVITE=<secret> PARAWATCH_VERSION=0.3.27 bash setup.sh
#
# RELAY_INVITE is needed the first time only; later runs keep the one the server has.
# APP_DOMAIN lets the phone web app at that name call the relay (CORS). The app itself is served
# from S3 and CloudFront (infra/terraform/modules/web); SERVE_WEB=1 makes this server serve it from
# /var/www/parawatch-web instead, as relays set up before 0.3.28 did.
set -euo pipefail

: "${RELAY_DOMAIN:?set RELAY_DOMAIN to the name the machines will use}"
APP_DOMAIN="${APP_DOMAIN:-}"
SERVE_WEB="${SERVE_WEB:-}"
PARAWATCH_VERSION="${PARAWATCH_VERSION:-latest}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
DATA=/var/lib/parawatch-relay
ENV_FILE=/etc/parawatch-relay.env
UNIT_FILE=/etc/systemd/system/parawatch-relay.service
PKG=/opt/parawatch/lib/node_modules/parawatch/package.json

if [ -z "${RELAY_INVITE:-}" ] && [ ! -s "$ENV_FILE" ]; then
  echo "set RELAY_INVITE to the secret that lets you make spaces (this server has none yet)" >&2
  exit 1
fi

# a fingerprint of everything the relay runs with, to restart it only when that changed
fingerprint() { cat "$ENV_FILE" "$UNIT_FILE" "$PKG" /opt/node/bin/node 2>/dev/null | sha256sum | cut -c1-16; }
before=$(fingerprint)

export DEBIAN_FRONTEND=noninteractive
if ! command -v caddy >/dev/null || ! command -v curl >/dev/null || ! command -v xz >/dev/null; then
  apt-get update -q
  apt-get install -y -q curl xz-utils caddy
fi

arch=$(uname -m)
case "$arch" in
  x86_64) narch=x64 ;;
  aarch64) narch=arm64 ;;
  *) echo "unsupported architecture $arch" >&2; exit 1 ;;
esac
if ! /opt/node/bin/node --version 2>/dev/null | grep -qx "v$NODE_VERSION"; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$narch.tar.xz" -o /tmp/node.tar.xz
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  rm /tmp/node.tar.xz
fi
export PATH="/opt/node/bin:$PATH" HOME="${HOME:-/root}"
installed=$(node -p "require('$PKG').version" 2>/dev/null || true)
if [ "$PARAWATCH_VERSION" = latest ] || [ "$installed" != "$PARAWATCH_VERSION" ]; then
  npm install -g --prefix /opt/parawatch "parawatch@$PARAWATCH_VERSION"
fi

id parawatch >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin parawatch
mkdir -p "$DATA" && chown parawatch:parawatch "$DATA" && chmod 700 "$DATA"

umask 077
if [ -n "${RELAY_INVITE:-}" ]; then
  printf 'PARAWATCH_RELAY_INVITE=%s\n' "$RELAY_INVITE" > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
fi

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=parawatch relay
After=network-online.target
Wants=network-online.target

[Service]
User=parawatch
EnvironmentFile=$ENV_FILE
ExecStart=/opt/node/bin/node /opt/parawatch/lib/node_modules/parawatch/dist/bin/cli.js relay serve --host 127.0.0.1 --port 8787 --data $DATA
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

umask 022
{
  echo "$RELAY_DOMAIN {"
  echo "	encode gzip"
  if [ -n "$APP_DOMAIN" ]; then
    cat <<CADDY
	# the phone web app calls the relay from its own origin
	@app header Origin https://$APP_DOMAIN
	header @app {
		Access-Control-Allow-Origin "https://$APP_DOMAIN"
		Access-Control-Allow-Methods "GET, PUT, DELETE, POST, OPTIONS"
		Access-Control-Allow-Headers "authorization, content-type"
		Access-Control-Max-Age "86400"
		Vary Origin
	}
	@preflight {
		method OPTIONS
		header Origin https://$APP_DOMAIN
	}
	respond @preflight 204
CADDY
  fi
  echo "	reverse_proxy 127.0.0.1:8787"
  echo "}"
  if [ -n "$APP_DOMAIN" ] && [ -n "$SERVE_WEB" ]; then
    mkdir -p /var/www/parawatch-web
    cat <<CADDY

$APP_DOMAIN {
	encode gzip
	root * /var/www/parawatch-web
	# small files under fixed names: always ask, so a new version never mixes with the old
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Cache-Control "no-cache"
	}
	file_server
}
CADDY
  fi
} > /etc/caddy/Caddyfile.new
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.new >/dev/null
if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
else
  rm /etc/caddy/Caddyfile.new
fi

systemctl daemon-reload
systemctl enable --quiet parawatch-relay
if [ "$before" != "$(fingerprint)" ] || ! systemctl is-active --quiet parawatch-relay; then
  systemctl restart parawatch-relay
  echo "relay restarted"
fi
for _ in $(seq 20); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:8787/healthz >/dev/null
echo "relay $(node -p "require('$PKG').version") up at https://$RELAY_DOMAIN"
