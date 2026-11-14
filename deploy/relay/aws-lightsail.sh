#!/usr/bin/env bash
# Makes a parawatch relay on Amazon Lightsail: a 1 GB Ubuntu instance with a static IP and ports 80
# and 443 open, set up by setup.sh on first boot. Point your domain at the IP it prints (or pass
# HOSTED_ZONE to have it done in Route 53); Caddy gets the HTTPS certificate once the name resolves.
#
#   RELAY_DOMAIN=relay.example.com [AWS_PROFILE=...] [REGION=ap-northeast-2] [HOSTED_ZONE=Z123] bash aws-lightsail.sh
#
# The invite is made here and kept in ~/.parawatch-relay-invite (mode 600); it is never printed.
set -euo pipefail

: "${RELAY_DOMAIN:?set RELAY_DOMAIN to the name the machines will use}"
REGION="${REGION:-ap-northeast-2}"
NAME="${NAME:-parawatch-relay}"
HERE="$(cd "$(dirname "$0")" && pwd)"
INVITE_FILE="$HOME/.parawatch-relay-invite"
aws() { command aws --region "$REGION" "$@"; }

if [ ! -s "$INVITE_FILE" ]; then
  (umask 077 && openssl rand -base64 32 | tr -d '\n' > "$INVITE_FILE")
fi

if ! aws lightsail get-instance --instance-name "$NAME" >/dev/null 2>&1; then
  bundle=$(aws lightsail get-bundles --query "bundles[?ramSizeInGb==\`1.0\` && isActive && contains(supportedPlatforms, 'LINUX_UNIX') && !contains(bundleId, 'ipv6')].bundleId | [0]" --output text)
  zone=$(aws lightsail get-regions --include-availability-zones --query "regions[?name=='$REGION'].availabilityZones[0].zoneName | [0]" --output text)
  userdata=$(mktemp)
  trap 'rm -f "$userdata"' EXIT
  {
    echo "#!/bin/bash"
    printf 'export RELAY_DOMAIN=%q RELAY_INVITE=%q\n' "$RELAY_DOMAIN" "$(cat "$INVITE_FILE")"
    cat "$HERE/setup.sh"
  } > "$userdata"
  echo "making $NAME ($bundle in $zone)"
  aws lightsail create-instances --instance-names "$NAME" --availability-zone "$zone" --blueprint-id ubuntu_24_04 --bundle-id "$bundle" --user-data "file://$userdata" >/dev/null
  aws lightsail wait instance-running --instance-name "$NAME" 2>/dev/null || sleep 60
fi

if ! aws lightsail get-static-ip --static-ip-name "$NAME-ip" >/dev/null 2>&1; then
  aws lightsail allocate-static-ip --static-ip-name "$NAME-ip" >/dev/null
  aws lightsail attach-static-ip --static-ip-name "$NAME-ip" --instance-name "$NAME" >/dev/null
fi
aws lightsail put-instance-public-ports --instance-name "$NAME" --port-infos \
  fromPort=22,toPort=22,protocol=tcp fromPort=80,toPort=80,protocol=tcp fromPort=443,toPort=443,protocol=tcp >/dev/null
ip=$(aws lightsail get-static-ip --static-ip-name "$NAME-ip" --query staticIp.ipAddress --output text)

if [ -n "${HOSTED_ZONE:-}" ]; then
  command aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE" --change-batch \
    "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$RELAY_DOMAIN\",\"Type\":\"A\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$ip\"}]}}]}" >/dev/null
  echo "pointed $RELAY_DOMAIN at $ip"
else
  echo "point $RELAY_DOMAIN (an A record) at $ip"
fi
cat <<NEXT

When https://$RELAY_DOMAIN/healthz answers (setup takes a few minutes after the first boot):

  parawatch relay setup https://$RELAY_DOMAIN ~/agent-sync/parawatch --device <this machine> --invite "\$(cat $INVITE_FILE)"
NEXT
