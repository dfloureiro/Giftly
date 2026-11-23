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
data seed || exit 1

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

if [ "$fails" != 0 ]; then echo "backup/restore: $fails check(s) failed"; exit 1; fi
echo "backup/restore: all checks passed"
