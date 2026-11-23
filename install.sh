#!/bin/sh
# Giftly one-step install: Docker Compose + (optionally) a Cloudflare Tunnel.
#
#   curl -fsSL https://raw.githubusercontent.com/dfloureiro/Giftly/main/install.sh -o install.sh
#   sh install.sh
#
# Asks for your domain and Cloudflare Tunnel token (both optional), writes .env with a strong
# admin password (and cloudflared.env with the token, which Giftly itself never sees), starts
# everything and prints how to log in. Files come from the latest release, not from main.
#
# Re-running it updates and restarts. It never overwrites .env or cloudflared.env, and never
# replaces a compose.yaml you changed (the new one is saved as compose.yaml.new instead; put
# your changes in compose.override.yaml, which it never touches).
#
# Non-interactive: set GIFTLY_DOMAIN, TUNNEL_TOKEN, ADMIN_USERNAME (and GIFTLY_DIR, GIFTLY_PORT)
# in the environment, and GIFTLY_YES=1 to skip the questions.
set -eu

REPO=dfloureiro/Giftly
DIR=${GIFTLY_DIR:-giftly}
PORT=${GIFTLY_PORT:-3000}

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" "default"
  eval "cur=\${$1:-}"
  if [ -n "$cur" ] || [ "${GIFTLY_YES:-}" = 1 ] || [ ! -r /dev/tty ]; then return; fi
  printf '%s ' "$2" >/dev/tty
  # shellcheck disable=SC2034 # read by the eval below
  read -r ans </dev/tty || ans=''
  eval "$1=\${ans:-\$3}"
}

# --- Docker -------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then COMPOSE='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE='docker-compose'
else die "Docker Compose is not installed. See https://docs.docker.com/compose/install/"; fi
docker info >/dev/null 2>&1 || die "can't talk to Docker. Is it running? (You may need sudo, or to be in the docker group.)"

# --- Files --------------------------------------------------------------------------------
mkdir -p "$DIR"
cd "$DIR"
fetch() { # fetch URL FILE ("-" = stdout)
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-64; }

# Files from the latest release (a fixed tag), unless GIFTLY_REPO_RAW points elsewhere.
if [ -n "${GIFTLY_REPO_RAW:-}" ]; then
  REPO_RAW=$GIFTLY_REPO_RAW
else
  TAG=$(fetch "https://api.github.com/repos/$REPO/releases/latest" - 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1) || TAG=''
  [ -n "$TAG" ] || die "couldn't find the latest Giftly release (is GitHub reachable?)"
  REPO_RAW="https://raw.githubusercontent.com/$REPO/$TAG"
  say "Giftly $TAG"
fi

# compose.yaml: replaced only if you never changed it (checked against what install.sh wrote
# last time, or any official version from before this check existed).
OFFICIAL='10f10e1706af00a29972946527f578b49e38d052bd8f90f8d84fdff8bf2d7fce 9d43d63e5d4eddc1f90dc0af7e3732057adfbab1ba7eb7d2705dc2c8a86d658e'
fetch "$REPO_RAW/compose.yaml" compose.yaml.new
if [ ! -f compose.yaml ]; then
  mv compose.yaml.new compose.yaml
elif [ "$(sha compose.yaml)" = "$(sha compose.yaml.new)" ]; then
  rm -f compose.yaml.new
else
  current=$(sha compose.yaml)
  pristine=0
  [ -f .compose.sha256 ] && [ "$current" = "$(cat .compose.sha256)" ] && pristine=1
  case " $OFFICIAL " in *" $current "*) pristine=1 ;; esac
  if [ "$pristine" = 1 ]; then
    mv compose.yaml.new compose.yaml
  else
    say "Your compose.yaml has local changes, so it was kept. The new version is in compose.yaml.new."
    say "  Tip: move your changes to compose.override.yaml, then: mv compose.yaml.new compose.yaml"
  fi
fi
[ -f compose.yaml.new ] || sha compose.yaml > .compose.sha256

# Before 3.4 the tunnel token lived in .env (so Giftly saw it too): move it to cloudflared.env.
if [ -f .env ] && grep -q '^TUNNEL_TOKEN=' .env && [ ! -f cloudflared.env ]; then
  (umask 077 && grep '^TUNNEL_TOKEN=' .env > cloudflared.env)
  grep -v '^TUNNEL_TOKEN=' .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
  say "Moved TUNNEL_TOKEN from .env to cloudflared.env (only cloudflared gets it now)."
fi

if [ -f .env ]; then
  say "Using the existing $(pwd)/.env (not changed)."
  FRESH=0
else
  FRESH=1
  say "Giftly setup. Press Enter to skip a question."
  ask GIFTLY_DOMAIN 'Domain for Giftly (e.g. gifts.example.com, empty = only this computer):' ''
  GIFTLY_DOMAIN=$(printf '%s' "${GIFTLY_DOMAIN:-}" | sed -e 's|^https\{0,1\}://||' -e 's|/.*$||')
  if [ -n "$GIFTLY_DOMAIN" ]; then
    ask TUNNEL_TOKEN 'Cloudflare Tunnel token (empty = no tunnel):' ''
  fi
  ask ADMIN_USERNAME 'Admin username [admin]:' 'admin'
  ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
  PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)

  umask 077
  {
    say "# Created by install.sh. ADMIN_* only create the first account; you can remove them after."
    say "ADMIN_USERNAME=$ADMIN_USERNAME"
    say "ADMIN_PASSWORD=$PASSWORD"
    [ -n "$GIFTLY_DOMAIN" ] && say "BASE_URL=https://$GIFTLY_DOMAIN"
    [ "$PORT" != 3000 ] && say "GIFTLY_PORT=$PORT"
    say "# Other settings: https://github.com/dfloureiro/Giftly#configuration"
  } > .env
  chmod 600 .env
  if [ -n "${TUNNEL_TOKEN:-}" ]; then
    say "TUNNEL_TOKEN=$TUNNEL_TOKEN" > cloudflared.env
    chmod 600 cloudflared.env
  fi
fi

# --- Start --------------------------------------------------------------------------------
PROFILE=''
[ -f cloudflared.env ] && grep -q '^TUNNEL_TOKEN=.' cloudflared.env && PROFILE='--profile tunnel'
say "Starting Giftly…"
# shellcheck disable=SC2086
$COMPOSE $PROFILE pull -q
# shellcheck disable=SC2086
$COMPOSE $PROFILE up -d

PORT=$(sed -n 's/^GIFTLY_PORT=//p' .env | tail -n 1)
PORT=${PORT:-3000}
i=0
until $COMPOSE exec -T giftly wget -qO- "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 30 ] && die "Giftly didn't start. Logs: cd $(pwd) && $COMPOSE logs giftly"
  sleep 1
done

URL=$(sed -n 's/^BASE_URL=//p' .env | tail -n 1)
say ""
say "Giftly is running."
say "  On this computer: http://localhost:$PORT/admin"
if [ -n "$URL" ]; then
  if [ -n "$PROFILE" ]; then
    say "  On the internet:  $URL/admin"
    say "    (in Cloudflare, the tunnel's public hostname must point to http://giftly:3000)"
  else
    say "  On the internet:  $URL/admin  (once your proxy or tunnel points to port $PORT)"
  fi
fi
if [ "$FRESH" = 1 ]; then
  say "  Username: $ADMIN_USERNAME"
  say "  Password: $PASSWORD"
  say "Keep this password: it's also in $(pwd)/.env (readable only by you)."
fi
C="$COMPOSE${PROFILE:+ $PROFILE}"
say "Update later with: cd $(pwd) && $C pull && $C up -d"
