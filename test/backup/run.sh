#!/bin/sh
# End-to-end test for scripts/backup.sh and scripts/restore.sh on a real Docker install of the
# image built from this checkout: seed real data with photos → back up → wipe → restore into a
# new release → everything is back; failed restores switch back to the previous release.
#   sh test/backup/run.sh            (from the repository root; needs Docker and Node.js)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
REG=127.0.0.1:5556
export GIFTLY_REPO_RAW="file://$ROOT" GIFTLY_YES=1 GIFTLY_READY_TRIES=30 GIFTLY_IMAGE="$REG/giftly" GIFTLY_TAG=5
BASE=http://127.0.0.1:3000
fails=0
ok() { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cleanup() {
  (cd "$WORK/g" && docker compose down -v >/dev/null 2>&1) || true
  docker rm -f giftly-test-registry-bk >/dev/null 2>&1 || true
  docker run --rm -v "$WORK":/w busybox:1.36 sh -c 'rm -rf /w/*/data' >/dev/null 2>&1 || true
  rm -rf "${WORK:?}" || true
}
trap cleanup EXIT
data() { node "$ROOT/test/backup/data.mjs" "$1" "$BASE" bk "$PASS" "$WORK/state.json"; }
in_dir() { (cd "$WORK/g" && "$@"); }
in_g() { in_dir docker compose exec -T giftly "$@"; }
current() { in_g node /app/scripts/release.js current 2>/dev/null; }
started() { docker inspect -f '{{.State.StartedAt}}' "$(in_dir docker compose ps -q giftly)"; }
resum() { # resum DIR ARCHIVE: rewrite the checksums of an unpacked backup and pack it again
  (cd "$1" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | while read -r f; do sha256sum "$f"; done > "$WORK/sums" && mv "$WORK/sums" SHA256SUMS && tar czf "$2" .)
}

docker run -d --name giftly-test-registry-bk -p "$REG:5000" registry:2 >/dev/null
docker build -q -t "$REG/giftly:5" "$ROOT" >/dev/null
i=0; until docker push -q "$REG/giftly:5" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 20 ] || { echo "registry didn't start"; exit 1; }; sleep 1; done

mkdir -p "$WORK/g"
(cd "$WORK" && GIFTLY_DIR=g ADMIN_USERNAME=bk sh "$ROOT/install.sh") > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; exit 1; }
PASS=$(sed -n 's/^ADMIN_PASSWORD=//p' "$WORK/g/.env")
# B0: the fresh, empty install (a restore of it would remove everything seeded below).
in_dir sh "$ROOT/scripts/backup.sh" > "$WORK/b0.log" 2>&1 || { cat "$WORK/b0.log"; exit 1; }
B0=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | head -n 1)
mkdir -p "$WORK/b0keep" && mv "$B0" "$WORK/b0keep/" && B0="$WORK/b0keep/$(basename "$B0")"
data seed || exit 1
sleep 1

# Backups: one without the session secret, one with it.
in_dir sh "$ROOT/scripts/backup.sh" > "$WORK/b1.log" 2>&1 || { cat "$WORK/b1.log"; exit 1; }
B1=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | head -n 1)
sleep 1
in_dir sh "$ROOT/scripts/backup.sh" --include-secrets --keep 5 > "$WORK/b2.log" 2>&1 || { cat "$WORK/b2.log"; exit 1; }
B2=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | tail -n 1)
check "backup has database, photos, manifest, checksums" "tar tzf '$B1' | grep -q '^giftly.db$' && [ \"\$(tar tzf '$B1' | grep -c '^images/.')\" -ge 3 ] && tar tzf '$B1' | grep -q '^manifest.json$' && tar tzf '$B1' | grep -q '^SHA256SUMS$'"
check "backup is private (600) and outside the data folder" "[ \"\$(ls -l '$B1' | cut -c1-10)\" = -rw------- ] && case '$B1' in */data/*) false ;; *) true ;; esac"
check "no session secret unless asked" "! tar tzf '$B1' | grep -q session-secret && tar tzf '$B2' | grep -q session-secret"
check "no staging leftovers in /data" "! in_g sh -c 'ls -A /data' | grep -q '^.backup-'"
check "backup holds exactly the photos its database uses" "[ \"\$(tar tzf '$B1' | grep -c '^images/.')\" = \"\$(tar xzOf '$B1' manifest.json | sed -n 's/.*\"images\": *\\([0-9]*\\).*/\\1/p' | head -n 1)\" ]"

# Lose everything: containers, the data folder, and start an empty Giftly.
in_dir docker compose down >/dev/null 2>&1
docker run --rm -v "$WORK/g":/g busybox:1.36 rm -rf /g/data
in_dir docker compose up -d >/dev/null 2>&1
i=0; until in_g wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || exit 1; sleep 1; done
check "after wiping, the data is gone" "data absent"
EMPTY=$(current)
T0=$(started)

# Refused backups change nothing, and Giftly is never stopped for them.
mkdir -p "$WORK/bad"; tar xzf "$B1" -C "$WORK/bad"; printf 'x' >> "$WORK/bad/giftly.db"
(cd "$WORK/bad" && tar czf "$WORK/damaged.tar.gz" .)
check "damaged backup refused" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$WORK/damaged.tar.gz' > '$WORK/r0.log' 2>&1 && grep -q \"checksums don't match\" '$WORK/r0.log' && grep -q 'Nothing was changed' '$WORK/r0.log'"
mkdir -p "$WORK/new"; tar xzf "$B1" -C "$WORK/new"
sed -i 's/"giftly": *"[^"]*"/"giftly": "99.0.0"/' "$WORK/new/manifest.json"; resum "$WORK/new" "$WORK/newer.tar.gz"
check "backup from a newer Giftly refused" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$WORK/newer.tar.gz' > '$WORK/r1.log' 2>&1 && grep -q 'newer than the one installed' '$WORK/r1.log'"
mkdir -p "$WORK/v3"; tar xzf "$B1" -C "$WORK/v3"
sed -i 's/"format": *2/"format": 1/' "$WORK/v3/manifest.json"; resum "$WORK/v3" "$WORK/v3.tar.gz"
check "3.x backup format refused, with what to do" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$WORK/v3.tar.gz' > '$WORK/r1b.log' 2>&1 && grep -q 'older format' '$WORK/r1b.log'"
check "still empty, same release, Giftly never stopped, nothing left behind" "data absent && [ \"\$(current)\" = '$EMPTY' ] && [ \"\$(started)\" = '$T0' ] && [ \"\$(in_g ls /data/releases | wc -l)\" = 1 ] && ! in_g ls -A /data/releases | grep -q '^.tmp-'"

# The real restore.
if in_dir sh "$ROOT/scripts/restore.sh" --yes "$B1" > "$WORK/r2.log" 2>&1; then ok "restore succeeds"; else bad "restore succeeds"; cat "$WORK/r2.log"; fi
R1=$(current)
check "lists, wishlist, gifts and photos all back and served" "data verify"
check "served from a new release; the replaced one is kept as it was" "[ '$R1' != '$EMPTY' ] && in_g node /app/scripts/served.js --expect '$R1' >/dev/null && in_g test -f /data/releases/$EMPTY/giftly.db && grep -q 'releases/$EMPTY' '$WORK/r2.log'"

# A non-Compose setup (GIFTLY_CONTAINER), with the session secret.
CID=$(in_dir docker compose ps -q giftly)
if in_dir env GIFTLY_CONTAINER="$CID" sh "$ROOT/scripts/restore.sh" --yes "$B2" > "$WORK/r3.log" 2>&1; then ok "restore with GIFTLY_CONTAINER"; else bad "restore with GIFTLY_CONTAINER"; cat "$WORK/r3.log"; fi
R2=$(current)
check "everything back after that restore too" "data verify && [ '$R2' != '$R1' ]"

# --- A restore whose data Giftly won't serve switches back to the previous release --------------
# The hook damages the unpacked release after its checks (a photo disappears; the database is
# replaced by an empty one): Giftly refuses it (fingerprint), so restore.sh must switch back.
# (The photo case restores B1, which has photos; the empty-database one B0.)
for damage in photo empty; do
  if [ "$damage" = photo ]; then BK=$B1; else BK=$B0; fi
  # shellcheck disable=SC2016 # expanded by restore.sh's test hook (NEW, CID, IMAGE)
  case $damage in
    photo) HOOK='docker run --rm --volumes-from "$CID" busybox:1.36 sh -c "rm -f /data/releases/$NEW/images/*"' ;;
    empty) HOOK='docker run --rm --volumes-from "$CID" --entrypoint node "$IMAGE" -e "const f = process.argv[1]; require(\"node:fs\").rmSync(f); new (require(\"node:sqlite\").DatabaseSync)(f).close()" "/data/releases/$NEW/giftly.db"' ;;
  esac
  if in_dir env GIFTLY_READY_TRIES=15 GIFTLY_RESTORE_TEST_HOOK="$HOOK" sh "$ROOT/scripts/restore.sh" --yes "$BK" > "$WORK/r4$damage.log" 2>&1; then
    bad "$damage: failed restore reported as failure"; cat "$WORK/r4$damage.log"
  else ok "$damage: failed restore reported as failure"; fi
  check "$damage: says the previous data is back and served" "grep -q 'previous data is back and being served' '$WORK/r4$damage.log'"
  check "$damage: previous release current and served, data and photos intact" "[ \"\$(current)\" = '$R2' ] && in_g node /app/scripts/served.js --expect '$R2' >/dev/null && data verify"
  check "$damage: the failed release is kept and named" "F=\$(sed -n 's|.*failed release is kept in /data/releases/\\([^ .]*\\).*|\\1|p' '$WORK/r4$damage.log') && [ -n \"\$F\" ] && in_g test -d /data/releases/\$F"
done

# A stopped Giftly stays stopped; the switch is done, and it serves the backup once started.
in_dir docker compose stop giftly >/dev/null 2>&1
if in_dir sh "$ROOT/scripts/restore.sh" --yes "$B1" > "$WORK/r5.log" 2>&1; then ok "restore while stopped"; else bad "restore while stopped"; cat "$WORK/r5.log"; fi
check "stopped: stays stopped" "[ \"\$(docker inspect -f '{{.State.Running}}' '$CID')\" = false ] && grep -q 'stays stopped' '$WORK/r5.log'"
in_dir docker compose start giftly >/dev/null 2>&1
NEW=$(sed -n 's|.*now points to the backup (/data/releases/\([^)]*\)).*|\1|p' "$WORK/r5.log")
i=0; until in_g node /app/scripts/served.js --expect "$NEW" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || break; sleep 1; done
check "stopped: serves the backup once started" "in_g node /app/scripts/served.js --expect '$NEW' >/dev/null && data verify"

# --- A photo vanishing between the snapshot and the copy -------------------------------------
# Like the app replacing a photo: the database stops using it, then the file is deleted. The
# first attempt misses it; the retry, from a fresh snapshot, is complete.
# shellcheck disable=SC2016 # expanded by the shell inside the container
REPLACE='[ "$ATTEMPT" != 1 ] || node -e "
  const { DatabaseSync } = require(\"node:sqlite\");
  const db = new DatabaseSync(\"/data/current/giftly.db\");
  const { image_file: f } = db.prepare(\"SELECT image_file FROM items WHERE image_file IS NOT NULL\").get();
  db.prepare(\"UPDATE items SET image_file = NULL WHERE image_file = ?\").run(f);
  require(\"node:fs\").unlinkSync(\"/data/current/images/\" + f);
"'
if in_dir env GIFTLY_BACKUP_TEST_HOOK="$REPLACE" sh "$ROOT/scripts/backup.sh" > "$WORK/b3.log" 2>&1; then ok "photo replaced mid-backup: retried and succeeded"; else bad "photo replaced mid-backup: retried and succeeded"; cat "$WORK/b3.log"; fi
B3=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | tail -n 1)
check "retry: said so" "grep -q 'trying again from a fresh snapshot' '$WORK/b3.log'"
check "retry: the archive has the 2 photos still used, and restores" "[ \"\$(tar tzf '$B3' | grep -c '^images/.')\" = 2 ] && in_dir sh '$ROOT/scripts/restore.sh' --yes '$B3' > '$WORK/r6.log' 2>&1"

# A photo that is simply gone (always deleted after the snapshot): no archive is published,
# and --keep doesn't prune the previous ones.
# shellcheck disable=SC2016 # expanded by the shell inside the container
GONE='node -e "
  const { DatabaseSync } = require(\"node:sqlite\");
  const { image_file: f } = new DatabaseSync(\"/data/current/giftly.db\").prepare(\"SELECT image_file FROM wishlist_items WHERE image_file IS NOT NULL\").get();
  try { require(\"node:fs\").unlinkSync(\"/data/current/images/\" + f); } catch {}
"'
# shellcheck disable=SC2034 # read by the check below (through eval)
before=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort)
sleep 1
if in_dir env GIFTLY_BACKUP_TEST_HOOK="$GONE" sh "$ROOT/scripts/backup.sh" --keep 1 > "$WORK/b4.log" 2>&1; then bad "missing photo: backup fails"; cat "$WORK/b4.log"; else ok "missing photo: backup fails"; fi
check "missing photo: says which and how to go on" "grep -q 'missing from' '$WORK/b4.log' && grep -q -- '--allow-missing-images' '$WORK/b4.log'"
check "missing photo: nothing published, nothing pruned, no temp files" "[ \"\$(find '$WORK/g/backups' -name 'giftly-backup-*.tar.gz' | sort)\" = \"\$before\" ] && [ -z \"\$(ls -A '$WORK/g/backups' | grep '^.giftly-backup')\" ]"
check "missing photo: no staging left in /data" "! in_g sh -c 'ls -A /data' | grep -q '^.backup-'"
sleep 1
if in_dir sh "$ROOT/scripts/backup.sh" --allow-missing-images > "$WORK/b5.log" 2>&1; then ok "--allow-missing-images publishes"; else bad "--allow-missing-images publishes"; cat "$WORK/b5.log"; fi
B5=$(find "$WORK/g/backups" -name 'giftly-backup-*.tar.gz' | sort | tail -n 1)
check "--allow-missing-images: listed in the manifest" "tar xzOf '$B5' manifest.json | grep -q '\"missing_images\"'"
check "restore refuses a backup missing photos, without the flag" "! in_dir sh '$ROOT/scripts/restore.sh' --yes '$B5' > '$WORK/r7.log' 2>&1 && grep -q 'missing 1 photo' '$WORK/r7.log' && grep -q 'Nothing was changed' '$WORK/r7.log'"
check "and restores it with the flag" "in_dir sh '$ROOT/scripts/restore.sh' --yes --allow-missing-images '$B5' > '$WORK/r8.log' 2>&1"

if [ "$fails" != 0 ]; then echo "backup/restore: $fails check(s) failed"; exit 1; fi
echo "backup/restore: all checks passed"
