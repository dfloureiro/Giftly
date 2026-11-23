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
# BACKUP_DIR (default ./backups) is where giftly-backup-<date>.tar.gz goes. Copy it to ANOTHER
# machine too (rsync, restic, a NAS…): a backup on the same disk dies with that disk.
#
# The file always holds password hashes and two-factor secrets: keep it private (it is written
# as 600) and encrypt it if it leaves your machines.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

SECRETS=0
KEEP=''
while [ $# -gt 0 ]; do
  case "$1" in
    --include-secrets) SECRETS=1 ;;
    --keep) [ $# -ge 2 ] || die "--keep needs a number"; KEEP=$2; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
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

# Inside the container: a consistent snapshot (VACUUM INTO, safe while Giftly runs), the images,
# a manifest and checksums, streamed out as one tar.gz. The staging folder is always removed.
docker exec -e STAMP="$STAMP" -e SECRETS="$SECRETS" "$CID" sh -c '
  set -e
  T="/data/.backup-$STAMP"
  trap "rm -rf \"$T\"" EXIT
  rm -rf "$T"; mkdir -p "$T/images"
  node -e "
    const { DatabaseSync } = require(\"node:sqlite\");
    const db = new DatabaseSync(\"/data/giftly.db\");
    db.exec(\"VACUUM INTO '\''$T/giftly.db'\''\");
    process.stdout.write(String(db.prepare(\"PRAGMA user_version\").get().user_version));
  " > "$T/.schema"
  if [ -d /data/images ]; then
    for f in /data/images/*; do [ -f "$f" ] && cp -p "$f" "$T/images/"; done
  fi
  if [ "$SECRETS" = 1 ] && [ -f /data/.session-secret ]; then cp -p /data/.session-secret "$T/session-secret"; fi
  cd "$T"
  version=$(node -p "require(\"/app/package.json\").version")
  images=$(find images -type f | wc -l | tr -d " ")
  printf "{\"format\":1,\"giftly\":\"%s\",\"schema\":%s,\"created_at\":\"%s\",\"images\":%s,\"includes_secrets\":%s}\n" \
    "$version" "$(cat .schema)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$images" "$([ "$SECRETS" = 1 ] && echo true || echo false)" > manifest.json
  rm -f .schema
  find . -type f ! -name SHA256SUMS | sed "s|^\./||" | sort | while read -r f; do sha256sum "$f"; done > SHA256SUMS
  tar czf - .
' > "$TMP" || die "the backup failed (see above); nothing was written"

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
