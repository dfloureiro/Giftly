#!/bin/sh
# Giftly one-step install: Docker Compose + (optionally) a Cloudflare Tunnel.
#
#   curl -fsSL https://raw.githubusercontent.com/dfloureiro/Giftly/main/install.sh -o install.sh
#   sh install.sh
#
# Asks for your domain and Cloudflare Tunnel token (both optional), writes .env with a strong
# admin password (and cloudflared.env with the token, which Giftly itself never sees), starts
# everything, checks that it really works and prints how to log in. Files come from the latest
# release, not from main.
#
# Re-running it updates and restarts. It never overwrites .env or cloudflared.env, never
# replaces a compose.yaml you changed (the new one is saved as compose.yaml.new; put your
# changes in compose.override.yaml, which it never touches), and if the update leaves Giftly
# or the tunnel down, it puts your settings back and says so.
#
# Non-interactive: set GIFTLY_DOMAIN, TUNNEL_TOKEN, ADMIN_USERNAME (and GIFTLY_DIR, GIFTLY_PORT)
# in the environment, and GIFTLY_YES=1 to skip the questions.
set -eu

REPO=dfloureiro/Giftly
DIR=${GIFTLY_DIR:-giftly}
PORT=${GIFTLY_PORT:-3000}
READY_TRIES=${GIFTLY_READY_TRIES:-45}   # seconds to wait for Giftly and for the tunnel
PROBE=__giftly_install_probe__

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

# Secrets are only ever written privately and atomically: a 0600 temporary file in the same
# folder (mktemp), then mv over the target. Content comes from stdin.
write_secret() {
  tmp=$(umask 077 && mktemp ./.giftly-tmp.XXXXXX) || die "can't create a temporary file in $(pwd)"
  if ! cat > "$tmp"; then rm -f "$tmp"; die "can't write $1"; fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$1"
}
# Any group/other permission on a secrets file is removed (with a note).
lock_down() {
  for f in "$@"; do
    [ -f "$f" ] || continue
    # shellcheck disable=SC2012 # fixed file names; ls -l reads permissions the same everywhere
    case "$(ls -l "$f" | cut -c5-10)" in
      ------) ;;
      *) chmod 600 "$f"; say "Note: $f was readable by other users; it is now private (600)." ;;
    esac
  done
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
lock_down .env cloudflared.env
rm -f ./.giftly-tmp.?????? # leftovers of an interrupted earlier run

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
OFFICIAL='10f10e1706af00a29972946527f578b49e38d052bd8f90f8d84fdff8bf2d7fce 9d43d63e5d4eddc1f90dc0af7e3732057adfbab1ba7eb7d2705dc2c8a86d658e 26383f047c300561b626778df8fa31cde2e0c28000ddef5aa588e999b0f8d698'
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

# Does the ACTIVE configuration (compose.yaml + compose.override.yaml) give cloudflared its
# settings from cloudflared.env? Checked with a harmless probe value, never assumed.
cloudflared_reads_env_file() {
  had=0; [ -f cloudflared.env ] && had=1
  [ "$had" = 1 ] || printf 'TUNNEL_TOKEN=%s\n' "$PROBE" | write_secret cloudflared.env
  if $COMPOSE --profile tunnel config 2>/dev/null | grep -q "$PROBE"; then ok=0; else ok=1; fi
  [ "$had" = 1 ] || rm -f cloudflared.env
  return "$ok"
}

# Before 3.4 the tunnel token lived in .env (so Giftly saw it too). Move it to cloudflared.env,
# but only if the active configuration reads it from there; keep a backup to roll back.
MIGRATED=0
BACKUP=''
if [ -f .env ] && grep -q '^TUNNEL_TOKEN=.' .env && [ ! -f cloudflared.env ]; then
  if cloudflared_reads_env_file; then
    BACKUP=".env.backup-$(date +%Y%m%d%H%M%S)"
    write_secret "$BACKUP" < .env
    grep '^TUNNEL_TOKEN=' .env | write_secret cloudflared.env
    grep -v '^TUNNEL_TOKEN=' .env | write_secret .env
    MIGRATED=1
    say "Moved TUNNEL_TOKEN from .env to cloudflared.env (only cloudflared gets it now; backup: $BACKUP)."
  else
    say "Note: TUNNEL_TOKEN stays in .env, because your compose setup gives it to cloudflared from there."
    say "  To keep the token away from Giftly: in compose.yaml or compose.override.yaml, give the"
    say "  cloudflared service 'env_file: cloudflared.env' (and no TUNNEL_TOKEN under 'environment'),"
    say "  move the TUNNEL_TOKEN=... line from .env to cloudflared.env, and run this script again."
  fi
fi

rollback() { # put the settings back as they were before this run, restart, and stop with $1
  if [ "$MIGRATED" = 1 ] && [ -n "$BACKUP" ]; then
    write_secret .env < "$BACKUP"
    rm -f cloudflared.env
    say "Your previous .env was put back (TUNNEL_TOKEN in .env again)."
    # shellcheck disable=SC2086
    $COMPOSE --profile tunnel up -d >/dev/null 2>&1 || true
  fi
  die "$1"
}

FRESH=0
if [ -f .env ]; then
  say "Using the existing $(pwd)/.env (not changed)."
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
  {
    say "# Created by install.sh. ADMIN_* only create the first account; you can remove them after."
    say "ADMIN_USERNAME=$ADMIN_USERNAME"
    say "ADMIN_PASSWORD=$PASSWORD"
    [ -n "$GIFTLY_DOMAIN" ] && say "BASE_URL=https://$GIFTLY_DOMAIN"
    [ "$PORT" != 3000 ] && say "GIFTLY_PORT=$PORT"
    say "# Other settings: https://github.com/dfloureiro/Giftly#configuration"
  } | write_secret .env
  if [ -n "${TUNNEL_TOKEN:-}" ]; then
    say "TUNNEL_TOKEN=$TUNNEL_TOKEN" | write_secret cloudflared.env
  fi
fi

# --- Start --------------------------------------------------------------------------------
TUNNEL=0
{ [ -f cloudflared.env ] && grep -q '^TUNNEL_TOKEN=.' cloudflared.env; } && TUNNEL=1
grep -q '^TUNNEL_TOKEN=.' .env 2>/dev/null && TUNNEL=1
PROFILE=''
[ "$TUNNEL" = 1 ] && PROFILE='--profile tunnel'
say "Starting Giftly…"
# shellcheck disable=SC2086
$COMPOSE $PROFILE pull -q || rollback "couldn't download the images"
# shellcheck disable=SC2086
$COMPOSE $PROFILE up -d || rollback "couldn't start Giftly. Logs: cd $(pwd) && $COMPOSE logs"

# --- Check it really works ----------------------------------------------------------------
in_giftly() { $COMPOSE exec -T giftly "$@" >/dev/null 2>&1; }
i=0
until in_giftly wget -qO- "http://127.0.0.1:3000/healthz"; do
  i=$((i + 1))
  [ "$i" -ge "$READY_TRIES" ] && rollback "Giftly didn't start. Logs: cd $(pwd) && $COMPOSE logs giftly"
  sleep 1
done

if [ "$TUNNEL" = 1 ]; then
  # cloudflared answers /ready (metrics port, inside the Docker network) once it is connected
  # to Cloudflare. Older or custom compose files may not expose it: then it must at least be
  # running steadily (not restarting for lack of a token).
  if $COMPOSE --profile tunnel config 2>/dev/null | grep -q -- '--metrics'; then
    i=0
    until in_giftly wget -qO- "http://cloudflared:20241/ready"; do
      i=$((i + 1))
      [ "$i" -ge "$READY_TRIES" ] && rollback "the Cloudflare Tunnel didn't connect. Check the token; logs: cd $(pwd) && $COMPOSE logs cloudflared"
      sleep 1
    done
  else
    sleep 5
    state=$($COMPOSE --profile tunnel ps cloudflared --format '{{.State}}' 2>/dev/null | head -n 1)
    [ "$state" = running ] || rollback "cloudflared isn't running (${state:-stopped}). Logs: cd $(pwd) && $COMPOSE logs cloudflared"
  fi
fi

URL=$(sed -n 's/^BASE_URL=//p' .env | tail -n 1)
PORT=$(sed -n 's/^GIFTLY_PORT=//p' .env | tail -n 1)
PORT=${PORT:-3000}
PUBLIC=''
if [ -n "$URL" ] && command -v curl >/dev/null 2>&1; then
  # Only a hint: on a first install the public hostname may not be set up in Cloudflare yet.
  if curl -fsS -m 10 "$URL/healthz" >/dev/null 2>&1; then PUBLIC=ok; else PUBLIC=down; fi
fi
if [ -n "$BACKUP" ]; then rm -f "$BACKUP"; fi # everything works: the backup isn't needed any more

say ""
say "Giftly is running."
say "  On this computer: http://localhost:$PORT/admin"
if [ -n "$URL" ]; then
  say "  On the internet:  $URL/admin"
  if [ "$PUBLIC" = down ]; then
    if [ "$TUNNEL" = 1 ]; then
      say "    (not reachable yet: in Cloudflare, the tunnel's public hostname must point to http://giftly:3000)"
    else
      say "    (not reachable yet: point your reverse proxy or tunnel to port $PORT)"
    fi
  fi
fi
if [ "$FRESH" = 1 ]; then
  say "  Username: $ADMIN_USERNAME"
  say "  Password: $PASSWORD"
  say "Keep this password: it's also in $(pwd)/.env (readable only by you)."
fi
C="$COMPOSE${PROFILE:+ $PROFILE}"
say "Update later: run this script again (or: cd $(pwd) && $C pull && $C up -d)"
