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
# changes in compose.override.yaml, which it never touches). Before the new version can touch
# your data it saves a recovery point of it (data/pre-upgrade-<date>/). If the update leaves
# Giftly or the tunnel down, it puts back your settings, the exact images that worked and
# (if the new version ran) that data, keeping the failed attempt's data in
# data/failed-upgrade-<date>/, and says so.
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

# --- Snapshot ------------------------------------------------------------------------------
# Every file this script may change, saved before it changes anything (and which ones didn't
# exist yet), so a failed update can put back exactly the setup that worked. Private folder;
# the last 3 snapshots are kept.
SNAP_FILES='compose.yaml compose.override.yaml .env cloudflared.env .compose.sha256'
SNAP_NAME="$(date +%Y%m%d-%H%M%S)-$$"
SNAP=".giftly-backup/$SNAP_NAME"
PIN=localhost/giftly-rollback   # private tags that keep the images a snapshot needs
HAD_INSTALL=0
[ -f .env ] && HAD_INSTALL=1
(umask 077 && mkdir -p "$SNAP")
chmod 700 .giftly-backup "$SNAP"
for f in $SNAP_FILES; do
  if [ -f "$f" ]; then cp "$f" "$SNAP/$f" && chmod 600 "$SNAP/$f"; else echo "$f" >> "$SNAP/.absent"; fi
done
chmod 600 "$SNAP/.absent" 2>/dev/null || true
# The exact images the current containers run (a pull is about to move their tags to new ones),
# pinned under private tags so they can't be cleaned up while this snapshot exists.
#   .images: "service  image-as-configured  image-id"
OLD_CID=''
OLD_ID=''
if [ "$HAD_INSTALL" = 1 ] && [ -f compose.yaml ]; then
  for svc in giftly cloudflared; do
    cid=$($COMPOSE --profile tunnel ps -aq "$svc" 2>/dev/null | head -n 1) || cid=''
    [ -n "$cid" ] || continue
    ref=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null) || continue
    id=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null) || continue
    docker tag "$id" "$PIN:$svc-$SNAP_NAME" >/dev/null 2>&1 || continue
    printf '%s %s %s\n' "$svc" "$ref" "$id" >> "$SNAP/.images"
    [ "$svc" = giftly ] && OLD_CID=$cid && OLD_ID=$id
  done
fi
# Keep the last 3 snapshots, with their image pins and data recovery points.
# shellcheck disable=SC2012 # our own timestamped folder names
old=$(ls -1d .giftly-backup/*/ 2>/dev/null | sort -r | tail -n +4)
# shellcheck disable=SC2012 # our own timestamped folder names
KEEP_POINTS=$(ls -1d .giftly-backup/*/ 2>/dev/null | sort -r | head -n 3 | xargs -n 1 basename | tr '\n' ' ')
for d in $old; do
  name=$(basename "$d")
  for svc in giftly cloudflared; do docker rmi "$PIN:$svc-$name" >/dev/null 2>&1 || true; done
  rm -rf "${d:?}"
done

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
# but only if the active configuration reads it from there (the snapshot can undo it).
if [ -f .env ] && grep -q '^TUNNEL_TOKEN=.' .env && [ ! -f cloudflared.env ]; then
  if cloudflared_reads_env_file; then
    grep '^TUNNEL_TOKEN=' .env | write_secret cloudflared.env
    grep -v '^TUNNEL_TOKEN=' .env | write_secret .env
    say "Moved TUNNEL_TOKEN from .env to cloudflared.env (only cloudflared gets it now)."
  else
    say "Note: TUNNEL_TOKEN stays in .env, because your compose setup gives it to cloudflared from there."
    say "  To keep the token away from Giftly: in compose.yaml or compose.override.yaml, give the"
    say "  cloudflared service 'env_file: cloudflared.env' (and no TUNNEL_TOKEN under 'environment'),"
    say "  move the TUNNEL_TOKEN=... line from .env to cloudflared.env, and run this script again."
  fi
fi

# Which compose profile the files on disk call for (a tunnel token anywhere → the tunnel).
profile_now() {
  if { [ -f cloudflared.env ] && grep -q '^TUNNEL_TOKEN=.' cloudflared.env; } || grep -q '^TUNNEL_TOKEN=.' .env 2>/dev/null
  then echo '--profile tunnel'; fi
}

# Data recovery point: run a script against Giftly's /data with the previous container's mounts
# and image (or, without a container, as the compose files define it), script on stdin.
# `up -d` replaces the old container, so a stopped "holder" container keeps its mounts (and its
# volumes in use) for as long as this run may need them; it is removed when the script ends.
DATA_HOLDER=''
remove_holder() {
  if [ -n "$DATA_HOLDER" ]; then docker rm -f "$DATA_HOLDER" >/dev/null 2>&1 || true; fi
}
trap remove_holder EXIT
in_data() {
  if [ -n "$OLD_CID" ]; then
    if [ -z "$DATA_HOLDER" ]; then
      DATA_HOLDER=$(docker create --network none --volumes-from "$OLD_CID" --entrypoint true "$OLD_ID") || return 1
    fi
    docker run --rm -i --network none --volumes-from "$DATA_HOLDER" -e NAME="$SNAP_NAME" -e KEEP_POINTS="$KEEP_POINTS" \
      --entrypoint sh "$OLD_ID" -s
  else
    $COMPOSE run --rm --no-deps -T -e NAME="$SNAP_NAME" -e KEEP_POINTS="$KEEP_POINTS" --entrypoint sh giftly -s
  fi
}
# With Giftly stopped: a verified copy of the database (VACUUM INTO + integrity check), the
# session secret, and the photos (hard links: photo files never change once written).
checkpoint() {
  in_data <<'CHECKPOINT'
set -eu
C="/data/pre-upgrade-$NAME"
rm -rf "$C.tmp"; mkdir -p "$C.tmp/images"
if [ -f /data/giftly.db ]; then
  C="$C" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const out = `${process.env.C}.tmp/giftly.db`;
    new DatabaseSync("/data/giftly.db").exec(`VACUUM INTO '\''${out}'\''`);
    const check = new DatabaseSync(out, { readOnly: true }).prepare("PRAGMA integrity_check").get();
    if (Object.values(check)[0] !== "ok") { console.error("the copy of the database is damaged"); process.exit(1); }
  '
fi
if [ -d /data/images ]; then
  for f in /data/images/*; do [ -f "$f" ] || continue; ln "$f" "$C.tmp/images/" 2>/dev/null || cp -p "$f" "$C.tmp/images/"; done
  [ "$(ls /data/images | wc -l)" = "$(ls "$C.tmp/images" | wc -l)" ]
fi
if [ -f /data/.session-secret ]; then cp -p /data/.session-secret "$C.tmp/.session-secret"; fi
mv "$C.tmp" "$C"
# Recovery points whose snapshot is gone (only the last 3 are kept).
for d in /data/pre-upgrade-*; do
  [ -d "$d" ] || continue
  case " $KEEP_POINTS " in *" ${d#/data/pre-upgrade-} "*) ;; *) rm -rf "$d" ;; esac
done
CHECKPOINT
}
# After a failed candidate: its data (everything it may have written) goes to failed-upgrade-…,
# then the recovery point is copied back (the recovery point itself stays as it was).
restore_checkpoint() {
  in_data <<'RESTORE'
set -eu
C="/data/pre-upgrade-$NAME"; F="/data/failed-upgrade-$NAME"
[ -d "$C" ] || { echo "no recovery point at $C" >&2; exit 1; }
mkdir -p "$F"
for n in giftly.db giftly.db-wal giftly.db-shm .session-secret; do
  if [ -e "/data/$n" ]; then mv "/data/$n" "$F/$n"; fi
done
if [ -d /data/images ]; then
  mkdir -p "$F/images"
  for f in /data/images/*; do [ -f "$f" ] || continue; ln "$f" "$F/images/" 2>/dev/null || cp -p "$f" "$F/images/"; done
fi
if [ -f "$C/giftly.db" ]; then cp -p "$C/giftly.db" /data/giftly.db; fi
if [ -f "$C/.session-secret" ]; then cp -p "$C/.session-secret" /data/.session-secret; fi
mkdir -p /data/images
for f in "$C"/images/*; do
  [ -f "$f" ] || continue
  [ -e "/data/images/${f##*/}" ] || ln "$f" /data/images/ 2>/dev/null || cp -p "$f" /data/images/
done
RESTORE
}

# A failed update: put back every file from the snapshot (and remove those that didn't exist)
# and point the image tags back to the exact images that worked; if the new version already ran,
# put the data recovery point back too. Then restart and check that the previous setup works
# again. A failed FIRST install is not rolled back: Giftly may already have created the admin
# account with the password in .env.
DATA_POINT=0   # 2 = a recovery point exists and the new version may have changed the data
rollback() {
  reason=$1
  if [ "$HAD_INSTALL" != 1 ]; then die "$reason"; fi
  say "The update failed ($reason). Putting your previous setup back…"
  DATA_NOTE=''
  if [ "$DATA_POINT" = 2 ]; then
    # shellcheck disable=SC2086
    $COMPOSE --profile tunnel stop >/dev/null 2>&1 || true
    if restore_checkpoint; then
      DATA_NOTE=" Your data is back as it was before the update (recovery point: $(pwd)/data/pre-upgrade-$SNAP_NAME, or that folder inside Giftly's data volume); anything the failed version wrote is kept in data/failed-upgrade-$SNAP_NAME."
    else
      die "the update failed: $reason. Putting the data recovery point back failed too, so Giftly was left stopped. Nothing was deleted: the recovery point is in data/pre-upgrade-$SNAP_NAME and the failed version's data in data/failed-upgrade-$SNAP_NAME (inside Giftly's data volume). Settings snapshot: $(pwd)/$SNAP"
    fi
  fi
  if [ -f "$SNAP/.images" ]; then
    while read -r svc ref id; do docker tag "$id" "$ref" >/dev/null 2>&1 || true; done < "$SNAP/.images"
  fi
  for f in $SNAP_FILES; do
    if [ -f "$SNAP/$f" ]; then cp "$SNAP/$f" "$f"; fi
  done
  if [ -f "$SNAP/.absent" ]; then while read -r f; do rm -f "./$f"; done < "$SNAP/.absent"; fi
  chmod 600 .env 2>/dev/null || true
  [ -f cloudflared.env ] && chmod 600 cloudflared.env
  PROFILE=$(profile_now)
  # shellcheck disable=SC2086
  if $COMPOSE $PROFILE up -d >/dev/null 2>&1 && healthy; then
    die "the update failed: $reason. Your previous setup was restored and is working again (snapshot: $(pwd)/$SNAP).$DATA_NOTE"
  fi
  die "the update failed: $reason. Your previous files were restored from $(pwd)/$SNAP, but it didn't come back either ($REASON).$DATA_NOTE Logs: cd $(pwd) && $COMPOSE logs"
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

# --- Checks ---------------------------------------------------------------------------------
# healthy: Giftly answers, and (with a tunnel) cloudflared is connected. Sets REASON otherwise.
in_giftly() { $COMPOSE exec -T giftly "$@" >/dev/null 2>&1; }
healthy() {
  REASON=''
  i=0
  until in_giftly wget -qO- "http://127.0.0.1:3000/healthz"; do
    i=$((i + 1))
    if [ "$i" -ge "$READY_TRIES" ]; then REASON="Giftly didn't start"; return 1; fi
    sleep 1
  done
  [ -n "$PROFILE" ] || return 0
  # cloudflared answers /ready (metrics port, inside the Docker network) once it is connected
  # to Cloudflare. Older or custom compose files may not expose it: then it must at least be
  # running steadily (not restarting for lack of a token).
  if $COMPOSE --profile tunnel config 2>/dev/null | grep -q -- '--metrics'; then
    i=0
    until in_giftly wget -qO- "http://cloudflared:20241/ready"; do
      i=$((i + 1))
      if [ "$i" -ge "$READY_TRIES" ]; then REASON="the Cloudflare Tunnel didn't connect"; return 1; fi
      sleep 1
    done
  else
    sleep 5
    state=$($COMPOSE --profile tunnel ps cloudflared --format '{{.State}}' 2>/dev/null | head -n 1)
    if [ "$state" != running ]; then REASON="cloudflared isn't running (${state:-stopped})"; return 1; fi
  fi
  return 0
}

# --- Start ----------------------------------------------------------------------------------
PROFILE=$(profile_now)
say "Starting Giftly…"
# Download first, while the current version keeps running (a failed download changes no data).
# shellcheck disable=SC2086
$COMPOSE $PROFILE pull -q || rollback "couldn't download the images"
if [ "$HAD_INSTALL" = 1 ] && [ -f "$SNAP/compose.yaml" ]; then
  # Before the new version can migrate anything: stop Giftly and save a verified recovery point.
  say "Saving a recovery point of your data…"
  if [ -n "$OLD_CID" ]; then docker stop "$OLD_CID" >/dev/null 2>&1 || rollback "couldn't stop Giftly to save a recovery point"; fi
  checkpoint || rollback "couldn't save a recovery point of your data (nothing was changed)"
  DATA_POINT=2 # from here on, the new version may change the data
fi
# shellcheck disable=SC2086
$COMPOSE $PROFILE up -d || rollback "couldn't start the containers"
healthy || rollback "$REASON"

URL=$(sed -n 's/^BASE_URL=//p' .env | tail -n 1)
PORT=$(sed -n 's/^GIFTLY_PORT=//p' .env | tail -n 1)
PORT=${PORT:-3000}
PUBLIC=''
if [ -n "$URL" ] && command -v curl >/dev/null 2>&1; then
  # Only a hint: on a first install the public hostname may not be set up in Cloudflare yet.
  if curl -fsS -m 10 "$URL/healthz" >/dev/null 2>&1; then PUBLIC=ok; else PUBLIC=down; fi
fi

say ""
say "Giftly is running."
say "  On this computer: http://localhost:$PORT/admin"
if [ -n "$URL" ]; then
  say "  On the internet:  $URL/admin"
  if [ "$PUBLIC" = down ]; then
    if [ -n "$PROFILE" ]; then
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
if [ "$DATA_POINT" = 2 ]; then
  say "  Your data from before this update: data/pre-upgrade-$SNAP_NAME (inside Giftly's data folder; the last 3 are kept)."
fi
C="$COMPOSE${PROFILE:+ $PROFILE}"
say "Update later: run this script again (or: cd $(pwd) && $C pull && $C up -d)"
