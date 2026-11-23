#!/bin/sh
# Giftly backup: database + images in ONE file, written outside the data volume.
#
#   sh backup.sh                     # from the folder with Giftly's compose.yaml
#   GIFTLY_CONTAINER=giftly sh backup.sh   # any other setup (Portainer, docker run): container name
#
# Options:
#   --keep N            keep only the N newest backups in BACKUP_DIR (default: keep all)
#   --include-secrets   also include the session signing secret, so signed-in guests and admins
#                       stay signed in after a restore. Without it, they just sign in again.
#   --allow-missing-images  publish even if photos the database uses are missing from the data
#                       folder (listed in the manifest). Without it, such a backup fails.
# BACKUP_DIR (default ./backups) is where giftly-backup-<date>.tar.gz goes. Copy it to ANOTHER
# machine too (rsync, restic, a NAS…): a backup on the same disk dies with that disk.
#
# The file always holds password hashes and two-factor secrets: keep it private (it is written
# as 600) and encrypt it if it leaves your machines.
#
# Giftly keeps running. Each backup holds exactly the photos its database snapshot uses, checked
# before anything is written; if one is replaced while the backup runs, it retries from a fresh
# snapshot. A backup that can't be completed is not written, and old backups are not pruned.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

SECRETS=0
ALLOW_MISSING=0
KEEP=''
while [ $# -gt 0 ]; do
  case "$1" in
    --include-secrets) SECRETS=1 ;;
    --keep) [ $# -ge 2 ] || die "--keep needs a number"; KEEP=$2; shift ;;
    --allow-missing-images) ALLOW_MISSING=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
case "$KEEP" in ''|*[!0-9]*) [ -z "$KEEP" ] || die "--keep needs a number" ;; esac
[ "$KEEP" != 0 ] || die "--keep must be at least 1 (it would delete the new backup too)"

command -v docker >/dev/null 2>&1 || die "Docker is not installed"
if [ -n "${GIFTLY_CONTAINER:-}" ]; then CID=$GIFTLY_CONTAINER
else CID=$(docker compose ps -q giftly 2>/dev/null | head -n 1); fi
[ -n "$CID" ] || die "Giftly isn't running here. Run this next to its compose.yaml, or set GIFTLY_CONTAINER."

BACKUP_DIR=${BACKUP_DIR:-./backups}
(umask 077 && mkdir -p "$BACKUP_DIR")
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/giftly-backup-$STAMP.tar.gz"
TMP=$(umask 077 && mktemp "$BACKUP_DIR/.giftly-backup.XXXXXX")
trap 'rm -f "$TMP"' EXIT

# Inside the container (script on stdin, archive on stdout): a consistent snapshot (VACUUM INTO,
# safe while Giftly runs), the photos THAT snapshot uses, a check that they are all there, then
# a manifest and checksums, streamed out as one tar.gz. The staging folder is always removed.
# Photo files are never changed once written, only deleted when nothing uses them any more; so a
# photo missing here was replaced meanwhile, and a fresh snapshot no longer needs it.
# GIFTLY_BACKUP_TEST_HOOK is for the tests only: a command run after each snapshot (ATTEMPT=n).
docker exec -i -e STAMP="$STAMP" -e SECRETS="$SECRETS" -e ALLOW_MISSING="$ALLOW_MISSING" \
  -e HOOK="${GIFTLY_BACKUP_TEST_HOOK:-}" "$CID" sh -s > "$TMP" <<'INNER' || die "the backup failed (see above); nothing was written, and no old backup was removed"
set -eu
fail() { printf 'Error: %s\n' "$*" >&2; exit 3; }
T=$(mktemp -d "/data/.backup-$STAMP.XXXXXX")
trap 'rm -rf "$T"' EXIT
attempt=1
while :; do
  rm -rf "$T/giftly.db" "$T/images"; mkdir -p "$T/images"
  T="$T" node -e '
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("node:fs");
    const T = process.env.T;
    const live = new DatabaseSync("/data/giftly.db");
    live.exec(`VACUUM INTO '\''${T}/giftly.db'\''`);
    live.close();
    // Every photo the snapshot uses (list gifts, gifts to give, wishlist items).
    const db = new DatabaseSync(`${T}/giftly.db`, { readOnly: true });
    const refs = new Set();
    for (const t of ["items", "gifts", "wishlist_items"]) {
      if (!db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(t, "image_file")) continue;
      for (const r of db.prepare(`SELECT DISTINCT image_file AS f FROM ${t} WHERE image_file IS NOT NULL AND image_file != ?`).all("")) refs.add(r.f);
    }
    const bad = [...refs].filter((f) => !/^[a-z0-9]{8,40}\.(jpg|png|webp|gif|avif)$/.test(f));
    if (bad.length) { console.error(`Error: the database names unexpected photo files: ${bad.join(" ")}`); process.exit(3); }
    fs.writeFileSync(`${T}/.refs`, [...refs].sort().map((f) => f + "\n").join(""));
    fs.writeFileSync(`${T}/.schema`, String(db.prepare("PRAGMA user_version").get().user_version));
  '
  if [ -n "$HOOK" ]; then ATTEMPT=$attempt sh -c "$HOOK" </dev/null >&2; fi
  missing=''
  while IFS= read -r f; do
    cp -p "/data/images/$f" "$T/images/$f" 2>/dev/null || missing="$missing $f"
  done < "$T/.refs"
  [ -n "$missing" ] || break
  [ "$attempt" -lt 3 ] || break
  printf 'Note: photo(s)%s changed while backing up; trying again from a fresh snapshot.\n' "$missing" >&2
  attempt=$((attempt + 1))
done
if [ -n "$missing" ]; then
  if [ "$ALLOW_MISSING" != 1 ]; then
    fail "the database uses photo(s) missing from /data/images:$missing. Put them back, or replace or remove the photo on the gift that uses each one; or run with --allow-missing-images to back up without them."
  fi
  printf 'Warning: backing up WITHOUT these missing photo(s) (--allow-missing-images):%s\n' "$missing" >&2
fi
# The archive must hold exactly the photos the snapshot uses (minus any allowed missing ones).
expected=$(for f in $(cat "$T/.refs"); do case " $missing " in *" $f "*) ;; *) echo "$f" ;; esac; done)
got=$(cd "$T/images" && find . -type f | sed 's|^\./||' | sort)
[ "$expected" = "$got" ] || fail "the photos copied don't match the ones the database uses"
for f in $got; do [ -s "$T/images/$f" ] || fail "photo $f is empty"; done
if [ "$SECRETS" = 1 ] && [ -f /data/.session-secret ]; then cp -p /data/.session-secret "$T/session-secret"; fi
cd "$T"
version=$(node -p 'require("/app/package.json").version')
images=$(printf '%s' "$got" | grep -c . || true)
missing_json=''
if [ -n "$missing" ]; then
  missing_json=",\"missing_images\":[$(for f in $missing; do printf '"%s",' "$f"; done | sed 's/,$//')]"
fi
printf '{"format":1,"giftly":"%s","schema":%s,"created_at":"%s","images":%s,"includes_secrets":%s%s}\n' \
  "$version" "$(cat .schema)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$images" "$([ "$SECRETS" = 1 ] && echo true || echo false)" "$missing_json" > manifest.json
rm -f .schema .refs
find . -type f ! -name SHA256SUMS | sed "s|^\./||" | sort | while read -r f; do sha256sum "$f"; done > SHA256SUMS
tar czf - .
INNER

[ -s "$TMP" ] || die "the backup came out empty; nothing was written"
chmod 600 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT
say "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
[ "$SECRETS" = 1 ] && say "It includes the session secret: treat it as sensitive and encrypt it before copying it anywhere."

if [ -n "$KEEP" ]; then
  # shellcheck disable=SC2012 # our own timestamped file names
  ls -1 "$BACKUP_DIR"/giftly-backup-*.tar.gz 2>/dev/null | sort -r | tail -n "+$((KEEP + 1))" | while read -r old; do
    rm -f "$old" && say "Removed old backup: $old"
  done
fi
say "Remember to copy it to another machine as well."
