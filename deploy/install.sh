#!/usr/bin/env bash
# Voicy server installer for Debian/Ubuntu. The Voicy app uploads and runs it
# over SSH, but it works by hand too:
#
#   sudo VOICY_BOOTSTRAP_CODE=<code> bash install.sh            install or upgrade
#   sudo bash install.sh uninstall                              remove everything
#
# Re-running is safe: secrets and chosen ports are kept in /opt/voicy/.env.
#
# Environment (all optional except the bootstrap code on first install):
#   VOICY_BOOTSTRAP_CODE  single-use code that makes whoever redeems it the owner
#   VOICY_SERVER_NAME     display name, default "Voicy"
#   VOICY_PUBLIC_IP       public IPv4, autodetected when unset
#   VOICY_HTTPS_PORT      default: first free of 443, 7443, 9443, 10443
#   VOICY_IMAGE           voicy-server image, default ghcr.io/absolutemode/voicy-server:latest
set -euo pipefail

DIR=/opt/voicy
LIVEKIT_IMAGE=livekit/livekit-server:v1.13
CADDY_IMAGE=caddy:2.11
RTC_TCP_PORT=7881
RTC_UDP_PORT=7882

log() { echo "[voicy] $*" >&2; }
die() { echo "VOICY_ERROR $*"; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
command -v apt-get >/dev/null || die "only Debian/Ubuntu servers are supported"

compose() { docker compose --project-directory "$DIR" "$@"; }

if [ "${1:-install}" = uninstall ]; then
  if [ -f "$DIR/docker-compose.yml" ]; then
    compose down --volumes --remove-orphans || true
  fi
  rm -rf "$DIR"
  echo "VOICY_OK uninstalled"
  exit 0
fi

# A port is taken if something listens on it or if a NAT rule forwards it
# elsewhere (proxies often do that, and ss does not show it).
nat_rules() { { iptables -t nat -S 2>/dev/null; nft list ruleset 2>/dev/null; } | grep -iE 'dnat|redirect' || true; }
forwarded() { nat_rules | grep -i "$1" | grep -qE "dport $2( |$)"; }
tcp_busy() { ss -Hltn "sport = :$1" | grep -q . || forwarded tcp "$1"; }
udp_busy() { ss -Hlun "sport = :$1" | grep -q . || forwarded udp "$1"; }
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

install_docker() {
  command -v docker >/dev/null && docker compose version >/dev/null 2>&1 && return
  log "installing Docker"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null
}

install_docker
command -v curl >/dev/null || apt-get install -y -qq curl >/dev/null
mkdir -p "$DIR/data"
# .env and livekit.yaml hold the LiveKit signing secret, which would let any
# local user mint tokens. Containers run as root or read through bind
# mounts, so root-only files are enough.
chmod 700 "$DIR"
chown 10001 "$DIR/data"

# Keep what a previous run decided (ports, secrets); name and image can be
# changed on upgrade.
OVERRIDE_NAME=${VOICY_SERVER_NAME:-}
OVERRIDE_IMAGE=${VOICY_IMAGE:-}
OVERRIDE_CODE=${VOICY_BOOTSTRAP_CODE:-}
if [ -f "$DIR/.env" ]; then
  set -a; . "$DIR/.env"; set +a
  VOICY_BOOTSTRAP_CODE=${OVERRIDE_CODE:-${VOICY_BOOTSTRAP_CODE:-}}
  FRESH=0
else
  FRESH=1
fi

PUBLIC_IP=${VOICY_PUBLIC_IP:-$(curl -fsS4 --max-time 10 https://api.ipify.org || true)}
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not detect public IPv4, set VOICY_PUBLIC_IP"
DOMAIN="${PUBLIC_IP//./-}.sslip.io"

if [ "$FRESH" = 1 ]; then
  [ -n "${VOICY_BOOTSTRAP_CODE:-}" ] || die "VOICY_BOOTSTRAP_CODE is required for a new install"
  tcp_busy "$RTC_TCP_PORT" && die "TCP port $RTC_TCP_PORT is already in use"
  udp_busy "$RTC_UDP_PORT" && die "UDP port $RTC_UDP_PORT is already in use"
  if [ -z "${VOICY_HTTPS_PORT:-}" ]; then
    for p in 443 7443 9443 10443; do
      if ! tcp_busy "$p"; then VOICY_HTTPS_PORT=$p; break; fi
    done
    [ -n "${VOICY_HTTPS_PORT:-}" ] || die "no free HTTPS port, set VOICY_HTTPS_PORT"
  fi
  tcp_busy "$VOICY_HTTPS_PORT" && die "TCP port $VOICY_HTTPS_PORT is already in use"
  # Let's Encrypt validates on port 80 (HTTP) or 443 (TLS-ALPN); one must be ours.
  if tcp_busy 80; then
    [ "$VOICY_HTTPS_PORT" = 443 ] || die "ports 80 and 443 are both taken, Let's Encrypt needs one of them"
    VOICY_HTTP_PORT=8880
  else
    VOICY_HTTP_PORT=80
  fi
  LIVEKIT_API_KEY="API$(rand_hex 6)"
  LIVEKIT_API_SECRET="$(rand_hex 32)"
fi

if [ "$VOICY_HTTPS_PORT" = 443 ]; then PUBLIC_HOST=$DOMAIN; else PUBLIC_HOST="$DOMAIN:$VOICY_HTTPS_PORT"; fi
SERVER_NAME=$(printf '%s' "${OVERRIDE_NAME:-${VOICY_SERVER_NAME:-Voicy}}" | tr -d "'\"\\\\\$\`\n\r" | cut -c1-48)
IMAGE=${OVERRIDE_IMAGE:-${VOICY_IMAGE:-ghcr.io/absolutemode/voicy-server:latest}}

umask 077
cat > "$DIR/.env" <<EOF
VOICY_PUBLIC_IP=$PUBLIC_IP
VOICY_DOMAIN=$DOMAIN
VOICY_PUBLIC_HOST=$PUBLIC_HOST
VOICY_HTTPS_PORT=$VOICY_HTTPS_PORT
VOICY_HTTP_PORT=$VOICY_HTTP_PORT
VOICY_SERVER_NAME='$SERVER_NAME'
VOICY_BOOTSTRAP_CODE=${VOICY_BOOTSTRAP_CODE:-}
VOICY_IMAGE=$IMAGE
LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
EOF

cat > "$DIR/livekit.yaml" <<EOF
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: $RTC_TCP_PORT
  udp_port: $RTC_UDP_PORT
  node_ip: $PUBLIC_IP
  use_external_ip: false
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
room:
  auto_create: true
  max_participants: 10
  empty_timeout: 300
logging:
  level: info
EOF
chmod 600 "$DIR/livekit.yaml"
umask 022

cat > "$DIR/Caddyfile" <<'EOF'
{
	http_port {$VOICY_HTTP_PORT}
	https_port {$VOICY_HTTPS_PORT}
}

{$VOICY_DOMAIN}:{$VOICY_HTTPS_PORT} {
	handle /api/* {
		reverse_proxy 127.0.0.1:8080
	}
	# Invite landing pages
	handle /join/* {
		reverse_proxy 127.0.0.1:8080
	}
	# LiveKit signalling. voicy-server checks membership before every
	# connect, reconnect and resume: self-hosted LiveKit cannot revoke the
	# tokens of kicked members itself.
	@rtc path /rtc /rtc/*
	handle @rtc {
		forward_auth 127.0.0.1:8080 {
			uri /api/rtc-auth
		}
		reverse_proxy 127.0.0.1:7880
	}
	# Nothing else of LiveKit (e.g. its Twirp API) is public.
	handle {
		respond 404
	}
}
EOF

cat > "$DIR/docker-compose.yml" <<EOF
name: voicy
services:
  livekit:
    image: $LIVEKIT_IMAGE
    command: --config /etc/livekit.yaml
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
  voicy:
    image: \${VOICY_IMAGE}
    network_mode: host
    restart: unless-stopped
    env_file: .env
    environment:
      VOICY_BIND: 127.0.0.1:8080
      VOICY_DB: /data/voicy.db
    volumes:
      - ./data:/data
    depends_on: [livekit]
  caddy:
    image: $CADDY_IMAGE
    network_mode: host
    restart: unless-stopped
    environment:
      VOICY_DOMAIN: \${VOICY_DOMAIN}
      VOICY_HTTP_PORT: \${VOICY_HTTP_PORT}
      VOICY_HTTPS_PORT: \${VOICY_HTTPS_PORT}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
EOF

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  log "opening ports in ufw"
  for rule in "$VOICY_HTTP_PORT/tcp" "$VOICY_HTTPS_PORT/tcp" "$RTC_TCP_PORT/tcp" "$RTC_UDP_PORT/udp"; do
    ufw allow "$rule" >/dev/null
  done
fi

log "starting containers"
# A locally built voicy image is not in any registry; that is fine.
compose pull --quiet --ignore-pull-failures 2>/dev/null || true
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "no prebuilt voicy-server image, building it from source (a few minutes)"
  command -v git >/dev/null || apt-get install -y -qq git >/dev/null
  docker build -q -t "$IMAGE" "https://github.com/AbsoluteMode/voicy.git#main:server" >/dev/null
fi
compose up -d --remove-orphans
# Config files are bind-mounted, so an upgrade has to reload them explicitly.
compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || compose restart caddy

log "waiting for https://$PUBLIC_HOST (the first certificate can take a minute)"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$PUBLIC_HOST/api/info" >/dev/null 2>&1; then
    echo "VOICY_OK $PUBLIC_HOST"
    exit 0
  fi
  sleep 3
done
compose logs --tail 30 >&2 || true
die "server did not come up on https://$PUBLIC_HOST, check that TCP $VOICY_HTTPS_PORT/$VOICY_HTTP_PORT, TCP $RTC_TCP_PORT and UDP $RTC_UDP_PORT are open in your hosting firewall"
