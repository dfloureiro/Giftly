#!/bin/sh
# Giftly restore from a backup made by backup.sh (database + images).
#
#   sh restore.sh backups/giftly-backup-20261123-101500.tar.gz        # next to compose.yaml
#   GIFTLY_CONTAINER=giftly sh restore.sh FILE                          # any other setup
#   … --yes                                                              # don't ask to confirm
#
# Checks the backup first (manifest and checksums) and refuses one from a newer Giftly than the
# running one. Then it stops Giftly, moves the current data aside to /data/pre-restore-<date>/
# (nothing is deleted), puts the backup in place and starts Giftly again, which upgrades the
# database if the backup is from an older version.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

FILE=''
YES=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    -*) die "unknown option: $a" ;;
    *) FILE=$a ;;
  esac
done
[ -n "$FILE" ] || die "which backup? Usage: sh restore.sh giftly-backup-….tar.gz [--yes]"
[ -f "$FILE" ] || die "no such file: $FILE"
command -v docker >/dev/null 2>&1 || die "Docker is not installed"

if [ -n "${GIFTLY_CONTAINER:-}" ]; then CID=$GIFTLY_CONTAINER; COMPOSE=0
else CID=$(docker compose ps -aq giftly 2>/dev/null | head -n 1); COMPOSE=1; fi
[ -n "$CID" ] || die "can't find Giftly's container. Run this next to its compose.yaml, or set GIFTLY_CONTAINER."
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CID") || die "can't inspect container $CID"

# --- Check the backup before touching anything ----------------------------------------------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
tar xzf "$FILE" -C "$WORK" 2>/dev/null || die "not a readable backup (tar.gz): $FILE"
[ -f "$WORK/manifest.json" ] && [ -f "$WORK/SHA256SUMS" ] && [ -f "$WORK/giftly.db" ] || die "not a Giftly backup (manifest, checksums or database missing)"
if command -v sha256sum >/dev/null 2>&1; then CHECK='sha256sum -c'; else CHECK='shasum -a 256 -c'; fi
# shellcheck disable=SC2086
(cd "$WORK" && $CHECK SHA256SUMS >/dev/null 2>&1) || die "the backup is damaged: checksums don't match. Nothing was changed."
# Every file in the backup must be covered by the checksums (nothing added afterwards).
listed=$(sed 's/^[0-9a-f]*  //' "$WORK/SHA256SUMS" | sort)
present=$(cd "$WORK" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort)
[ "$listed" = "$present" ] || die "the backup has files its checksums don't cover. Nothing was changed."

field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}[,}].*/\1/p" "$WORK/manifest.json"; }
B_VERSION=$(field giftly)
B_SCHEMA=$(field schema)
APP_VERSION=$(docker run --rm --entrypoint node "$IMAGE" -p 'require("/app/package.json").version') || die "can't read Giftly's version from $IMAGE"
newer() { # is version $1 newer than $2?
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
}
if newer "$B_VERSION" "$APP_VERSION"; then
  die "this backup is from Giftly $B_VERSION (database schema $B_SCHEMA), newer than the one installed ($APP_VERSION). Update Giftly first, then restore."
fi
IMAGES=$(find "$WORK/images" -type f 2>/dev/null | wc -l | tr -d ' ')
say "Backup: Giftly $B_VERSION, schema $B_SCHEMA, $(field created_at), $IMAGES image(s)$([ -f "$WORK/session-secret" ] && echo ', with session secret')."

if [ "$YES" != 1 ]; then
  [ -r /dev/tty ] || die "add --yes to restore without being asked"
  printf 'Replace the current Giftly data with this backup? The current data is kept in /data/pre-restore-…/ [y/N] ' >/dev/tty
  read -r ans </dev/tty || ans=''
  case "$ans" in y|Y|yes|YES|s|S|sim) ;; *) die "cancelled; nothing was changed" ;; esac
fi

# --- Restore -----------------------------------------------------------------------------------
say "Stopping Giftly…"
if [ "$COMPOSE" = 1 ]; then docker compose stop giftly >/dev/null; else docker stop "$CID" >/dev/null; fi
STAMP=$(date -u +%Y%m%d-%H%M%S)
# A helper container with the same /data mount: move the current data aside, copy the backup in.
docker run --rm --volumes-from "$CID" -v "$WORK":/restore:ro -e STAMP="$STAMP" --entrypoint sh "$IMAGE" -c '
  set -e
  P="/data/pre-restore-$STAMP"
  mkdir -p "$P"
  for f in /data/giftly.db /data/giftly.db-wal /data/giftly.db-shm /data/images /data/.session-secret; do
    [ -e "$f" ] && mv "$f" "$P/"
  done
  cp /restore/giftly.db /data/giftly.db
  mkdir -p /data/images
  for f in /restore/images/*; do [ -f "$f" ] && cp "$f" /data/images/; done
  [ -f /restore/session-secret ] && cp /restore/session-secret /data/.session-secret && chmod 600 /data/.session-secret
  [ -f "$P/.session-secret" ] && [ ! -f /data/.session-secret ] && cp -p "$P/.session-secret" /data/.session-secret
  true
' || die "copying the backup in failed; your previous data is in /data/pre-restore-$STAMP/"

say "Starting Giftly…"
if [ "$COMPOSE" = 1 ]; then docker compose start giftly >/dev/null; else docker start "$CID" >/dev/null; fi
i=0
until docker exec "$CID" wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 45 ] && die "Giftly didn't start after the restore. Your previous data is in /data/pre-restore-$STAMP/ (logs: docker logs $CID)"
  sleep 1
done
say "Restored. Giftly is running with the backup from $(field created_at)."
say "The data it replaced is kept in /data/pre-restore-$STAMP/ (delete it when you're happy)."
[ -f "$WORK/session-secret" ] || say "Guests and admins may need to sign in again."
