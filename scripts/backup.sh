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
# Giftly keeps running. Each backup holds the current data release: exactly the photos its
# database snapshot uses, with a fingerprint that restore.sh checks; if a photo is replaced
# while the backup runs, it retries from a fresh snapshot. A backup that can't be completed is
# not written, and old backups are not pruned. Restore it with restore.sh (Giftly 4 or newer).
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

# Inside the container (scripts/backup.js, archive on stdout): a consistent snapshot of the
# current data release (VACUUM INTO, safe while Giftly runs), exactly the photos THAT snapshot
# uses, a fingerprint, manifest and checksums. It retries if a photo is replaced meanwhile, and
# fails rather than write an incomplete backup.
# GIFTLY_BACKUP_TEST_HOOK is for the tests only: a command run after each snapshot (ATTEMPT=n).
set --
[ "$SECRETS" = 1 ] && set -- "$@" --include-secrets
[ "$ALLOW_MISSING" = 1 ] && set -- "$@" --allow-missing-images
docker exec -i -e GIFTLY_BACKUP_TEST_HOOK="${GIFTLY_BACKUP_TEST_HOOK:-}" "$CID" \
  node --disable-warning=ExperimentalWarning /app/scripts/backup.js "$@" > "$TMP" \
  || die "the backup failed (see above); nothing was written, and no old backup was removed"

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
