#!/bin/sh
# End-to-end test for scripts/backup.sh and scripts/restore.sh on a real Docker install:
# seed real data with photos → back up → wipe the data volume → restore → everything is back.
#   sh test/backup/run.sh            (from the repository root; needs Docker and Node.js)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
export GIFTLY_REPO_RAW="file://$ROOT" GIFTLY_YES=1 GIFTLY_READY_TRIES=30 GIFTLY_TAG="${GIFTLY_TAG:-3}"
BASE=http://127.0.0.1:3000
fails=0
ok() { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cleanup() {
  (cd "$WORK/g" && docker compose down -v >/dev/null 2>&1) || true
  docker run --rm -v "$WORK":/w busybox:1.36 sh -c 'rm -rf /w/*/data' >/dev/null 2>&1 || true
  rm -rf "${WORK:?}" || true
}
trap cleanup EXIT
data() { node "$ROOT/test/backup/data.mjs" "$1" "$BASE" bk "$PASS" "$WORK/state.json"; }
in_dir() { (cd "$WORK/g" && "$@"); }

mkdir -p "$WORK/g"
(cd "$WORK" && GIFTLY_DIR=g ADMIN_USERNAME=bk sh "$ROOT/install.sh") > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; exit 1; }
PASS=$(sed -n 's/^ADMIN_PASSWORD=//p' "$WORK/g/.env")
# B0: the fresh, empty install (a restore of it would remove everything seeded below).
in_dir sh "$ROOT/scripts/backup.sh" > "$WORK/b0.log" 2>&1 || { cat "$WORK/b0.log"; exit 1; }
B0=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | head -n 1)
mkdir -p "$WORK/b0keep" && mv "$B0" "$WORK/b0keep/" && B0="$WORK/b0keep/$(basename "$B0")"
data seed || exit 1
# A backup made by the previous backup.sh (3.4.2 format): still restorable.
# (test/backup/backup-3.4.2.sh is that release's script, kept as a fixture: CI clones without history.)
mkdir -p "$WORK/old"
in_dir env BACKUP_DIR="$WORK/old" sh "$ROOT/test/backup/backup-3.4.2.sh" > "$WORK/bold.log" 2>&1 || { cat "$WORK/bold.log"; exit 1; }
BOLD=$(find "$WORK/old" -name 'giftly-backup-*.tar.gz' | head -n 1)
sleep 1

# Backups: one without the session secret, one with it.
in_dir sh "$ROOT/scripts/backup.sh" > "$WORK/b1.log" 2>&1 || { cat "$WORK/b1.log"; exit 1; }
B1=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | head -n 1)
sleep 1
in_dir sh "$ROOT/scripts/backup.sh" --include-secrets --keep 5 > "$WORK/b2.log" 2>&1 || { cat "$WORK/b2.log"; exit 1; }
B2=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | tail -n 1)
check "backup has database, photos, manifest, checksums" "tar tzf '$B1' | grep -q '^./giftly.db$' && [ \"\$(tar tzf '$B1' | grep -c '^./images/.')\" -ge 3 ] && tar tzf '$B1' | grep -q manifest.json && tar tzf '$B1' | grep -q SHA256SUMS"
check "backup is private (600) and outside the data folder" "[ \"\$(ls -l '$B1' | cut -c1-10)\" = -rw------- ] && case '$B1' in */data/*) false ;; *) true ;; esac"
check "no session secret unless asked" "! tar tzf '$B1' | grep -q session-secret && tar tzf '$B2' | grep -q session-secret"
check "no staging leftovers in /data" "! in_dir docker compose exec -T giftly sh -c 'ls -A /data' | grep -q '^.backup-'"
check "backup holds exactly the photos its database uses" "[ \"\$(tar tzf '$B1' | grep -c '^./images/.')\" = \"\$(sed -n 's/.*\"images\":\\([0-9]*\\).*/\\1/p' \"\$(mkdir -p '$WORK/m1' && tar xzf '$B1' -C '$WORK/m1' && echo '$WORK/m1/manifest.json')\")\" ]"

# Lose everything: containers, the data folder, and start an empty Giftly.
in_dir docker compose down >/dev/null 2>&1
docker run --rm -v "$WORK/g":/g busybox:1.36 rm -rf /g/data
in_dir docker compose up -d >/dev/null 2>&1
i=0; until in_dir docker compose exec -T giftly wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || exit 1; sleep 1; done
check "after wiping, the data is gone" "data absent"

# A damaged backup is refused, and changes nothing.
mkdir -p "$WORK/bad"; tar xzf "$B1" -C "$WORK/bad"; printf 'x' >> "$WORK/bad/giftly.db"
(cd "$WORK/bad" && tar czf "$WORK/damaged.tar.gz" .)
check "damaged backup refused" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$WORK/damaged.tar.gz' > '$WORK/r0.log' 2>&1 && grep -q \"checksums don't match\" '$WORK/r0.log'"
# A backup from a newer Giftly is refused (manifest and its checksum updated consistently).
mkdir -p "$WORK/new"; tar xzf "$B1" -C "$WORK/new"
sed -i 's/"giftly":"[^"]*"/"giftly":"99.0.0"/' "$WORK/new/manifest.json"
(cd "$WORK/new" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | while read -r f; do sha256sum "$f"; done > "$WORK/sums" && mv "$WORK/sums" SHA256SUMS && tar czf "$WORK/newer.tar.gz" .)
check "backup from a newer Giftly refused" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$WORK/newer.tar.gz' > '$WORK/r1.log' 2>&1 && grep -q 'newer than the one installed' '$WORK/r1.log'"
check "still empty after the refusals" "data absent"

# The real restore.
if in_dir sh "$ROOT/scripts/restore.sh" --yes "$B1" > "$WORK/r2.log" 2>&1; then ok "restore succeeds"; else bad "restore succeeds"; cat "$WORK/r2.log"; fi
check "lists, wishlist, gifts and photos all back and served" "data verify"
check "the replaced data was kept aside" "in_dir docker compose exec -T giftly sh -c 'ls -d /data/pre-restore-*' >/dev/null 2>&1"
check "no restore staging left in /data" "! in_dir docker compose exec -T giftly sh -c 'ls -A /data' | grep -q '^.restore-'"

# The 3.4.2 format, and a non-Compose setup (GIFTLY_CONTAINER).
CID=$(in_dir docker compose ps -q giftly)
if in_dir env GIFTLY_CONTAINER="$CID" sh "$ROOT/scripts/restore.sh" --yes "$BOLD" > "$WORK/r3.log" 2>&1; then ok "3.4.2 backup restores with GIFTLY_CONTAINER"; else bad "3.4.2 backup restores with GIFTLY_CONTAINER"; cat "$WORK/r3.log"; fi
check "everything back after the 3.4.2 restore" "data verify"

# --- A restore that fails puts the previous data back ----------------------------------------
# B0 is the empty install: had it gone through, the seeded data would be gone.
if in_dir env GIFTLY_RESTORE_TEST_FAIL=cutover sh "$ROOT/scripts/restore.sh" --yes "$B0" > "$WORK/r4.log" 2>&1; then bad "failed cutover reported as failure"; cat "$WORK/r4.log"; else ok "failed cutover reported as failure"; fi
check "failed cutover: says the previous data is back and running" "grep -q 'put back and Giftly is running with it again' '$WORK/r4.log'"
check "failed cutover: previous data and photos served again" "data verify"
check "failed cutover: the attempt is kept apart" "in_dir docker compose exec -T giftly sh -c 'ls /data/failed-restore-*/giftly.db' >/dev/null 2>&1"
check "failed cutover: no staging or empty pre-restore folder left" "! in_dir docker compose exec -T giftly sh -c 'ls -A /data' | grep -q '^.restore-'"

# A backup whose database passes every check but makes Giftly fail at startup (its schema
# version says 0, so the first migration fails on existing tables).
mkdir -p "$WORK/crash"; tar xzf "$B0" -C "$WORK/crash"
docker run --rm -v "$WORK/crash":/w --entrypoint node "ghcr.io/dfloureiro/giftly:$GIFTLY_TAG" -e \
  'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync("/w/giftly.db").exec("PRAGMA user_version = 0")'
docker run --rm -v "$WORK/crash":/w busybox:1.36 chmod -R a+rwX /w
(cd "$WORK/crash" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | while read -r f; do sha256sum "$f"; done > "$WORK/sums" && mv "$WORK/sums" SHA256SUMS && tar czf "$WORK/crash.tar.gz" .)
if in_dir sh "$ROOT/scripts/restore.sh" --yes "$WORK/crash.tar.gz" > "$WORK/r5.log" 2>&1; then bad "failed start reported as failure"; cat "$WORK/r5.log"; else ok "failed start reported as failure"; fi
check "failed start: says the previous data is back and running" "grep -q 'put back and Giftly is running with it again' '$WORK/r5.log'"
check "failed start: previous data and photos served again" "data verify"
check "failed start: the attempt is kept apart" "[ \"\$(in_dir docker compose exec -T giftly sh -c 'ls -d /data/failed-restore-*' | wc -l)\" -ge 2 ]"

# --- A photo vanishing between the snapshot and the copy -------------------------------------
# Like the app replacing a photo: the database stops using it, then the file is deleted. The
# first attempt misses it; the retry, from a fresh snapshot, is complete.
# shellcheck disable=SC2016 # expanded by the shell inside the container
REPLACE='[ "$ATTEMPT" != 1 ] || node -e "
  const { DatabaseSync } = require(\"node:sqlite\");
  const db = new DatabaseSync(\"/data/giftly.db\");
  const { image_file: f } = db.prepare(\"SELECT image_file FROM items WHERE image_file IS NOT NULL\").get();
  db.prepare(\"UPDATE items SET image_file = NULL WHERE image_file = ?\").run(f);
  require(\"node:fs\").unlinkSync(\"/data/images/\" + f);
"'
if in_dir env GIFTLY_BACKUP_TEST_HOOK="$REPLACE" sh "$ROOT/scripts/backup.sh" > "$WORK/b3.log" 2>&1; then ok "photo replaced mid-backup: retried and succeeded"; else bad "photo replaced mid-backup: retried and succeeded"; cat "$WORK/b3.log"; fi
B3=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | tail -n 1)
check "retry: said so" "grep -q 'trying again from a fresh snapshot' '$WORK/b3.log'"
check "retry: the archive has the 2 photos still used, and restores" "[ \"\$(tar tzf '$B3' | grep -c '^./images/.')\" = 2 ] && in_dir sh '$ROOT/scripts/restore.sh' --yes '$B3' > '$WORK/r6.log' 2>&1"

# A photo that is simply gone (always deleted after the snapshot): no archive is published,
# and --keep doesn't prune the previous ones.
# shellcheck disable=SC2016 # expanded by the shell inside the container
GONE='node -e "
  const { DatabaseSync } = require(\"node:sqlite\");
  const { image_file: f } = new DatabaseSync(\"/data/giftly.db\").prepare(\"SELECT image_file FROM wishlist_items WHERE image_file IS NOT NULL\").get();
  try { require(\"node:fs\").unlinkSync(\"/data/images/\" + f); } catch {}
"'
# shellcheck disable=SC2034 # read by the check below (through eval)
before=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort)
sleep 1
if in_dir env GIFTLY_BACKUP_TEST_HOOK="$GONE" sh "$ROOT/scripts/backup.sh" --keep 1 > "$WORK/b4.log" 2>&1; then bad "missing photo: backup fails"; cat "$WORK/b4.log"; else ok "missing photo: backup fails"; fi
check "missing photo: says which and how to go on" "grep -q 'missing from /data/images' '$WORK/b4.log' && grep -q -- '--allow-missing-images' '$WORK/b4.log'"
check "missing photo: nothing published, nothing pruned, no temp files" "[ \"\$(find '$WORK/g/backups' -name 'giftly-backup-*.tar.gz' | sort)\" = \"\$before\" ] && [ -z \"\$(ls -A '$WORK/g/backups' | grep '^.giftly-backup')\" ]"
check "missing photo: no staging left in /data" "! in_dir docker compose exec -T giftly sh -c 'ls -A /data' | grep -q '^.backup-'"
sleep 1
if in_dir sh "$ROOT/scripts/backup.sh" --allow-missing-images > "$WORK/b5.log" 2>&1; then ok "--allow-missing-images publishes"; else bad "--allow-missing-images publishes"; cat "$WORK/b5.log"; fi
B5=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | tail -n 1)
check "--allow-missing-images: listed in the manifest" "tar xzOf '$B5' ./manifest.json | grep -q '\"missing_images\":\\[\"'"
check "restore refuses a backup missing photos, without the flag" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$B5' > '$WORK/r7.log' 2>&1 && grep -q 'missing 1 photo' '$WORK/r7.log' && grep -q 'Nothing was changed' '$WORK/r7.log'"
check "and restores it with the flag" "in_dir sh '$ROOT/scripts/restore.sh' --yes --allow-missing-images '$B5' > '$WORK/r8.log' 2>&1"

if [ "$fails" != 0 ]; then echo "backup/restore: $fails check(s) failed"; exit 1; fi
echo "backup/restore: all checks passed"
