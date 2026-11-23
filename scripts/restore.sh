#!/bin/sh
# Giftly restore from a backup made by backup.sh (database + images).
#
#   sh restore.sh backups/giftly-backup-20261123-101500.tar.gz        # next to compose.yaml
#   GIFTLY_CONTAINER=giftly sh restore.sh FILE                          # any other setup
#   … --yes                                                              # don't ask to confirm
#   … --allow-missing-images      restore a backup even if photos its database uses are missing
#
# Before touching anything it checks the backup: manifest and checksums, the database itself, and
# that every photo the database uses is in it; it refuses one from a newer Giftly than the running
# one. It copies the backup next to the live data, then stops Giftly, moves the current data aside
# to /data/pre-restore-<date>/ (nothing is deleted), puts the backup in place and starts Giftly
# again, which upgrades the database if the backup is from an older version.
# If that fails at any step (or Giftly doesn't start with the restored data), it puts the
# previous data back as it was, keeps the failed attempt in /data/failed-restore-<date>/, and
# starts the previous Giftly again (if it was running).
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

FILE=''
YES=0
ALLOW_MISSING=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --allow-missing-images) ALLOW_MISSING=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
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
APP_VERSION=$(docker run --rm --network none --entrypoint node "$IMAGE" -p 'require("/app/package.json").version') || die "can't read Giftly's version from its image"
newer() { # is version $1 newer than $2?
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
}
if newer "$B_VERSION" "$APP_VERSION"; then
  die "this backup is from Giftly $B_VERSION (database schema $B_SCHEMA), newer than the one installed ($APP_VERSION). Update Giftly first, then restore."
fi

# The database must be intact, and every photo it uses must be in the backup. Checked with the
# running Giftly's own image, without network, on a copy.
docker run --rm -i --network none -v "$WORK":/restore:ro -e ALLOW_MISSING="$ALLOW_MISSING" --entrypoint node "$IMAGE" - <<'CHECK' || die "the backup didn't pass the checks above. Nothing was changed."
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const copy = `${require('node:os').tmpdir()}/check.db`;
fs.copyFileSync('/restore/giftly.db', copy);
let db;
try {
  db = new DatabaseSync(copy);
  const result = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
  if (result.join() !== 'ok') throw new Error(result.slice(0, 3).join('; '));
} catch (e) {
  console.error(`Error: the backup's database is damaged (${e.message}).`);
  process.exit(1);
}
const refs = new Set();
for (const t of ['items', 'gifts', 'wishlist_items']) {
  if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, 'image_file')) continue;
  for (const r of db.prepare(`SELECT DISTINCT image_file AS f FROM ${t} WHERE image_file IS NOT NULL AND image_file != ?`).all('')) refs.add(r.f);
}
const bad = [...refs].filter((f) => !/^[a-z0-9]{8,40}\.(jpg|png|webp|gif|avif)$/.test(f));
if (bad.length) { console.error(`Error: the backup's database names unexpected photo files: ${bad.join(' ')}`); process.exit(1); }
const missing = [...refs].filter((f) => !fs.existsSync(`/restore/images/${f}`));
if (missing.length) {
  if (process.env.ALLOW_MISSING !== '1') {
    console.error(`Error: the backup is missing ${missing.length} photo(s) its database uses: ${missing.join(' ')}.`);
    console.error('  To restore it anyway (those gifts show no photo), add --allow-missing-images.');
    process.exit(1);
  }
  console.error(`Warning: restoring WITHOUT ${missing.length} missing photo(s) (--allow-missing-images): ${missing.join(' ')}`);
}
CHECK
IMAGES=$(find "$WORK/images" -type f 2>/dev/null | wc -l | tr -d ' ')
say "Backup: Giftly $B_VERSION, schema $B_SCHEMA, $(field created_at), $IMAGES image(s)$([ -f "$WORK/session-secret" ] && echo ', with session secret')."

if [ "$YES" != 1 ]; then
  [ -r /dev/tty ] || die "add --yes to restore without being asked"
  printf 'Replace the current Giftly data with this backup? The current data is kept in /data/pre-restore-…/ [y/N] ' >/dev/tty
  read -r ans </dev/tty || ans=''
  case "$ans" in y|Y|yes|YES|s|S|sim) ;; *) die "cancelled; nothing was changed" ;; esac
fi

# --- Helpers ---------------------------------------------------------------------------------
STAMP=$(date -u +%Y%m%d-%H%M%S)
STAGE="/data/.restore-$STAMP"
PRE="/data/pre-restore-$STAMP"
FAILED="/data/failed-restore-$STAMP"
# A container with the same /data mount, from the same image, running the script on stdin.
# GIFTLY_RESTORE_TEST_FAIL is for the tests only (fails the cutover on purpose).
in_data() {
  docker run --rm -i --network none --volumes-from "$CID" -v "$WORK":/restore:ro \
    -e STAGE="$STAGE" -e PRE="$PRE" -e FAILED="$FAILED" -e FAIL="${GIFTLY_RESTORE_TEST_FAIL:-}" \
    --entrypoint sh "$IMAGE" -s
}
stop_app() { if [ "$COMPOSE" = 1 ]; then docker compose stop giftly >/dev/null; else docker stop "$CID" >/dev/null; fi; }
start_app() { if [ "$COMPOSE" = 1 ]; then docker compose start giftly >/dev/null; else docker start "$CID" >/dev/null; fi; }
healthy() {
  i=0
  until docker exec "$CID" wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt "${GIFTLY_READY_TRIES:-45}" ] || return 1
    sleep 1
  done
}

# Put the previous data back as a set: whatever is in place now goes to $FAILED, and what was
# moved aside (listed in the journal) comes back. Then start the previous Giftly if it was running.
rollback() { # rollback "what failed"
  say "The restore failed ($1). Putting the previous data back…"
  stop_app 2>/dev/null || true
  if ! in_data <<'ROLLBACK'
set -eu
J="$STAGE.journal"
# No journal: the cutover never started, so everything in /data is still the original.
if [ ! -f "$J" ]; then rm -rf "$STAGE"; exit 0; fi
mkdir -p "$FAILED"
for n in giftly.db giftly.db-wal giftly.db-shm images .session-secret; do
  if grep -qx "moved $n" "$J" 2>/dev/null || ! grep -qx "had $n" "$J" 2>/dev/null; then
    # Not an original still in place: it came from the restore (or a failed start).
    if [ -e "/data/$n" ]; then mv "/data/$n" "$FAILED/$n"; fi
  fi
done
for n in giftly.db giftly.db-wal giftly.db-shm images .session-secret; do
  if grep -qx "moved $n" "$J" 2>/dev/null; then mv "$PRE/$n" "/data/$n"; fi
done
rm -rf "$STAGE"
rmdir "$PRE" 2>/dev/null || true
rm -f "$J"
ROLLBACK
  then
    die "the restore failed ($1), and putting the previous data back failed too. Nothing was deleted: the previous data is in $PRE/ (and possibly still in /data), the failed attempt in $FAILED/ and $STAGE/. Giftly is stopped. Logs: docker logs $CID"
  fi
  if [ "$WAS_RUNNING" = true ]; then
    start_app || die "the restore failed ($1). The previous data is back in place, but Giftly didn't start (docker start $CID). The failed attempt is in $FAILED/."
    healthy || die "the restore failed ($1). The previous data is back in place, but Giftly isn't answering (logs: docker logs $CID). The failed attempt is in $FAILED/."
    die "the restore failed ($1). The previous data was put back and Giftly is running with it again. The failed attempt is kept in $FAILED/."
  fi
  die "the restore failed ($1). The previous data was put back (Giftly was stopped before, so it stays stopped). The failed attempt is kept in $FAILED/."
}

# --- Restore -----------------------------------------------------------------------------------
# 1. Copy the backup next to the live data (same disk: the cutover is a few renames) and check it.
clean_stage() {
  in_data <<'CLEAN' >/dev/null 2>&1 || true
rm -rf "$STAGE" "$STAGE.journal"
CLEAN
}
if ! in_data <<'STAGE'
set -eu
rm -rf "$STAGE"; mkdir -p "$STAGE/images"
cp /restore/giftly.db "$STAGE/giftly.db"
for f in /restore/images/*; do if [ -f "$f" ]; then cp "$f" "$STAGE/images/"; fi; done
if [ -f /restore/session-secret ]; then cp /restore/session-secret "$STAGE/session-secret"; chmod 600 "$STAGE/session-secret"; fi
cd "$STAGE"
grep -E '^[0-9a-f]{64}  (giftly\.db|images/[^/]+|session-secret)$' /restore/SHA256SUMS | sha256sum -c >/dev/null
STAGE
then
  clean_stage
  die "copying the backup next to the data failed. Nothing was changed."
fi

if [ "$WAS_RUNNING" = true ]; then
  say "Stopping Giftly…"
  stop_app || { clean_stage; die "couldn't stop Giftly. Nothing was changed."; }
fi

# 2. Cutover: move the current data aside, then the staged backup in. The journal records what
#    existed and what was moved, so a failure at any point can be undone exactly.
say "Putting the backup in place…"
in_data <<'CUTOVER' || rollback "putting the backup in place failed"
set -eu
J="$STAGE.journal"
: > "$J"
mkdir -p "$PRE"
for n in giftly.db giftly.db-wal giftly.db-shm images .session-secret; do
  if [ -e "/data/$n" ]; then echo "had $n" >> "$J"; fi
done
for n in giftly.db giftly.db-wal giftly.db-shm images .session-secret; do
  if [ -e "/data/$n" ]; then mv "/data/$n" "$PRE/$n"; echo "moved $n" >> "$J"; fi
done
mv "$STAGE/giftly.db" /data/giftly.db
if [ "$FAIL" = cutover ]; then echo "test: failing the cutover on purpose" >&2; exit 1; fi
mv "$STAGE/images" /data/images
if [ -f "$STAGE/session-secret" ]; then mv "$STAGE/session-secret" /data/.session-secret
elif [ -f "$PRE/.session-secret" ]; then cp -p "$PRE/.session-secret" /data/.session-secret; fi
CUTOVER

# 3. Start with the restored data; it must answer.
say "Starting Giftly…"
start_app || rollback "Giftly didn't start with the restored data"
healthy || rollback "Giftly didn't start with the restored data (logs: docker logs $CID)"
clean_stage
say "Restored. Giftly is running with the backup from $(field created_at)."
say "The data it replaced is kept in $PRE/ (delete it when you're happy)."
[ -f "$WORK/session-secret" ] || say "Guests and admins may need to sign in again."
