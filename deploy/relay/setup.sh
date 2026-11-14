#!/usr/bin/env bash
# Sets up a parawatch relay on a fresh Ubuntu 24.04 server: Node, parawatch, a service user, a
# systemd service and Caddy in front for HTTPS. Run as root, or let aws-lightsail.sh run it as the
# instance's launch script. Running it again updates parawatch and keeps the spaces.
#
#   RELAY_DOMAIN=relay.example.com RELAY_INVITE=<secret> bash setup.sh
#
# With APP_DOMAIN set, the same server also serves the phone web app (apps/web, built with
# `npm run build -w @parawatch/web` and copied to /var/www/parawatch-web) and lets it call the relay.
set -euo pipefail

: "${RELAY_DOMAIN:?set RELAY_DOMAIN to the name the machines will use}"
: "${RELAY_INVITE:?set RELAY_INVITE to the secret that lets you make spaces}"
APP_DOMAIN="${APP_DOMAIN:-}"
PARAWATCH_VERSION="${PARAWATCH_VERSION:-latest}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
DATA=/var/lib/parawatch-relay

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl xz-utils caddy

arch=$(uname -m)
case "$arch" in
  x86_64) narch=x64 ;;
  aarch64) narch=arm64 ;;
  *) echo "unsupported architecture $arch" >&2; exit 1 ;;
esac
if ! /opt/node/bin/node --version 2>/dev/null | grep -q "v$NODE_VERSION"; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$narch.tar.xz" -o /tmp/node.tar.xz
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  rm /tmp/node.tar.xz
fi
export PATH="/opt/node/bin:$PATH" HOME="${HOME:-/root}"
npm install -g --prefix /opt/parawatch "parawatch@$PARAWATCH_VERSION"

id parawatch >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin parawatch
mkdir -p "$DATA" && chown parawatch:parawatch "$DATA" && chmod 700 "$DATA"

umask 077
printf 'PARAWATCH_RELAY_INVITE=%s\n' "$RELAY_INVITE" > /etc/parawatch-relay.env

cat > /etc/systemd/system/parawatch-relay.service <<UNIT
[Unit]
Description=parawatch relay
After=network-online.target
Wants=network-online.target

[Service]
User=parawatch
EnvironmentFile=/etc/parawatch-relay.env
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
if [ -n "$APP_DOMAIN" ]; then
	mkdir -p /var/www/parawatch-web
	cat > /etc/caddy/Caddyfile <<CADDY
$RELAY_DOMAIN {
	encode gzip
	# the phone web app reads the relay from its own origin
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
	reverse_proxy 127.0.0.1:8787
}

$APP_DOMAIN {
	encode gzip
	root * /var/www/parawatch-web
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
	}
	@fresh path / /index.html /sw.js /manifest.webmanifest
	header @fresh Cache-Control "no-cache"
	file_server
}
CADDY
else
	cat > /etc/caddy/Caddyfile <<CADDY
$RELAY_DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8787
}
CADDY
fi

systemctl daemon-reload
systemctl enable --now parawatch-relay
systemctl restart parawatch-relay
systemctl reload caddy || systemctl restart caddy
echo "relay set up for https://$RELAY_DOMAIN"
