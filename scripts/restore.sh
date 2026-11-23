#!/bin/sh
# Giftly restore from a backup made by backup.sh (Giftly 4 or newer).
#
#   sh restore.sh backups/giftly-backup-20261123-101500.tar.gz        # next to compose.yaml
#   GIFTLY_CONTAINER=giftly sh restore.sh FILE                          # any other setup
#   … --yes                                                              # don't ask to confirm
#   … --allow-missing-images      restore a backup even if photos its database uses are missing
#
# The current data is never modified. The backup is checked (files, checksums, version, database
# integrity, photos, fingerprint) and unpacked into a NEW data release while Giftly keeps
# running; a backup that fails any check is refused before Giftly is stopped. Then Giftly is
# stopped, /data/current is switched to the new release (one atomic rename), Giftly is started
# and must serve exactly that release (it refuses data that doesn't match its fingerprint).
# If it doesn't, /data/current is switched back to the previous release and Giftly restarted
# with it; the failed release stays in /data/releases/ for inspection, and the exit status is
# nonzero. A Giftly that was stopped before stays stopped (the release is checked on disk, and
# again by Giftly when it starts).
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

FILE=''
YES=0
ALLOW=''
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --allow-missing-images) ALLOW=--allow-missing-images ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
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
# The exact image the container runs (its ID, not a tag that a pull may have moved since).
IMAGE=$(docker inspect -f '{{.Image}}' "$CID") || die "can't inspect container $CID"
WAS_RUNNING=$(docker inspect -f '{{.State.Running}}' "$CID")

# Giftly's own scripts, in a container with the same /data and image (works while it is stopped).
in_data() {
  docker run --rm -i --network none --volumes-from "$CID" --entrypoint node "$IMAGE" \
    --disable-warning=ExperimentalWarning "$@"
}
stop_app() { if [ "$COMPOSE" = 1 ]; then docker compose stop giftly >/dev/null; else docker stop "$CID" >/dev/null; fi; }
start_app() { if [ "$COMPOSE" = 1 ]; then docker compose start giftly >/dev/null; else docker start "$CID" >/dev/null; fi; }
# Does the running Giftly serve release $1 (or its upgrade)? Waits for it to start.
serves() {
  i=0
  until docker exec "$CID" node /app/scripts/served.js --expect "$1" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt "${GIFTLY_READY_TRIES:-45}" ] || return 1
    sleep 1
  done
}

PREV=$(in_data /app/scripts/release.js current) || die "can't read Giftly's current data release (is this Giftly 4 or newer?). Nothing was changed."

# --- 1. Check and unpack into a new release (the current data is not touched) -----------------
OUT=$(in_data /app/scripts/restore.js $ALLOW < "$FILE") || die "the backup was refused (see above). Nothing was changed."
NEW=$(printf '%s\n' "$OUT" | sed -n 's/^release=//p')
[ -n "$NEW" ] || die "the backup was unpacked, but no release name came back. Nothing was changed."

if [ "$YES" != 1 ]; then
  discard() { in_data /app/scripts/release.js discard "$NEW" >/dev/null 2>&1 || true; }
  [ -r /dev/tty ] || { discard; die "add --yes to restore without being asked. Nothing was changed."; }
  printf 'Switch Giftly to this backup? The current data stays in /data/releases/%s [y/N] ' "$PREV" >/dev/tty
  read -r ans </dev/tty || ans=''
  case "$ans" in y|Y|yes|YES|s|S|sim) ;; *) discard; die "cancelled; nothing was changed" ;; esac
fi
# GIFTLY_RESTORE_TEST_HOOK is for the tests only (a command run after unpacking; NEW, PREV, CID, IMAGE).
if [ -n "${GIFTLY_RESTORE_TEST_HOOK:-}" ]; then NEW=$NEW PREV=$PREV CID=$CID IMAGE=$IMAGE sh -c "$GIFTLY_RESTORE_TEST_HOOK"; fi

# --- 2. Switch (Giftly stopped) ----------------------------------------------------------------
if [ "$WAS_RUNNING" = true ]; then
  say "Stopping Giftly…"
  stop_app || die "couldn't stop Giftly. Nothing was changed (the checked backup is in /data/releases/$NEW)."
fi
if ! in_data /app/scripts/release.js switch "$NEW" >/dev/null; then
  if [ "$WAS_RUNNING" = true ]; then start_app || true; fi
  die "couldn't switch to the restored data. Nothing was changed (the checked backup is in /data/releases/$NEW)."
fi
if [ "$WAS_RUNNING" != true ]; then
  say "Restored: /data/current now points to the backup (/data/releases/$NEW)."
  say "Giftly was stopped and stays stopped; it checks the data again when it starts. The previous data is in /data/releases/$PREV."
  exit 0
fi

# --- 3. Start and check it serves the restored release; otherwise switch back -------------------
say "Starting Giftly…"
if start_app && serves "$NEW"; then
  say "Restored. Giftly is serving the backup (data release $NEW)."
  say "The previous data is kept in /data/releases/$PREV (old releases are removed automatically; the last 3 are kept)."
  [ -n "$(printf '%s\n' "$OUT" | grep -i secret || true)" ] || say "Guests and admins may need to sign in again if the backup has no session secret."
  exit 0
fi
say "Giftly didn't serve the restored data. Switching back to the previous data…"
stop_app 2>/dev/null || true
if ! in_data /app/scripts/release.js switch "$PREV" >/dev/null; then
  die "the restore failed, and switching back failed too. Giftly is stopped. To go back by hand: point /data/current to releases/$PREV (docker run --rm --volumes-from $CID --entrypoint node $IMAGE /app/scripts/release.js switch $PREV), then start Giftly. The failed release is /data/releases/$NEW. Logs: docker logs $CID"
fi
if start_app && serves "$PREV"; then
  die "the restore failed: Giftly didn't serve the backup (logs: docker logs $CID). The previous data is back and being served. The failed release is kept in /data/releases/$NEW."
fi
die "the restore failed, and Giftly isn't serving the previous data either, although /data/current points to it again (releases/$PREV). Logs: docker logs $CID. The failed release is /data/releases/$NEW."
