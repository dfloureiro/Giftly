#!/bin/sh
# Mutation check: prove that a test protects a line of code.
#
# Copies the repository to a temporary folder, replaces FROM with TO in FILE (FROM must occur
# exactly once), runs the given Node test files there, and reports:
#   CAUGHT    a test failed (or hung until the timeout): the protection is tested  → exit 0
#   SURVIVED  every test still passed: nothing notices if this guard disappears   → exit 1
# Your working copy is never modified.
#
#   tools/mutate.sh src/server.js "if (!list) return;" "" test/v34.test.js
#   tools/mutate.sh --name "no 2FA gate" src/server.js "FROM" "TO" test/a.test.js test/b.test.js
#
# Uses `node` (24+) if installed, otherwise Docker or Podman with node:24-alpine.
# MUTATE_TIMEOUT (seconds, default 300) bounds each run; a run that hangs counts as CAUGHT,
# but give such tests their own { timeout } so they fail clearly.
set -eu

die() { printf 'mutate: %s\n' "$*" >&2; exit 2; }
NAME=''
if [ "${1:-}" = --name ]; then NAME=$2; shift 2; fi
[ $# -ge 4 ] || die "usage: tools/mutate.sh [--name LABEL] FILE FROM TO TEST..."
FILE=$1 FROM=$2 TO=$3
shift 3
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/$FILE" ] || die "no such file: $FILE"
for t in "$@"; do [ -f "$ROOT/$t" ] || die "no such test file: $t"; done
LABEL=${NAME:-$FILE}

# How to run Node.
if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)'; then
  RUN=node
elif command -v docker >/dev/null 2>&1; then RUN=docker
elif command -v podman >/dev/null 2>&1; then RUN=podman
else die "needs Node.js 24+, Docker or Podman"; fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/giftly-mutate.XXXXXX")
# shellcheck disable=SC2329 # called by the trap
cleanup() { case "$WORK" in */giftly-mutate.*) rm -rf "$WORK" ;; esac; }
trap cleanup EXIT INT TERM
(cd "$ROOT" && tar cf - --exclude=./.git --exclude=./data --exclude=./node_modules .) | tar xf - -C "$WORK"

# Apply the mutation with Node itself (exact text, exactly once; no regex surprises).
# shellcheck disable=SC2016 # JavaScript, not shell
apply='
const fs = require("node:fs");
const [file, from, to] = process.argv.slice(1);
const s = fs.readFileSync(file, "utf8");
const n = s.split(from).length - 1;
if (n !== 1) { console.error(`mutate: FROM occurs ${n} times in ${file} (must be exactly once)`); process.exit(2); }
fs.writeFileSync(file, s.replace(from, () => to));
'
case "$RUN" in
  node) node -e "$apply" "$WORK/$FILE" "$FROM" "$TO" || exit 2 ;;
  *) $RUN run --rm -v "$WORK":/w:Z docker.io/library/node:24-alpine node -e "$apply" "/w/$FILE" "$FROM" "$TO" || exit 2 ;;
esac

TIMEOUT=${MUTATE_TIMEOUT:-300}
LIMIT=''
command -v timeout >/dev/null 2>&1 && LIMIT="timeout $TIMEOUT"
status=0
case "$RUN" in
  node) (cd "$WORK" && $LIMIT node --disable-warning=ExperimentalWarning --test "$@") > "$WORK/.mutate.log" 2>&1 || status=$? ;;
  *) $LIMIT $RUN run --rm -v "$WORK":/w:Z -w /w docker.io/library/node:24-alpine \
       node --disable-warning=ExperimentalWarning --test "$@" > "$WORK/.mutate.log" 2>&1 || status=$? ;;
esac

summary=$(grep -E '^ℹ (pass|fail) ' "$WORK/.mutate.log" | tr '\n' ' ')
if [ "$status" = 0 ]; then
  printf 'SURVIVED  %s  (%s) — no test notices this change\n' "$LABEL" "$summary"
  exit 1
fi
if [ "$status" = 124 ]; then printf 'CAUGHT    %s  (timed out after %ss)\n' "$LABEL" "$TIMEOUT"
else printf 'CAUGHT    %s  (%s)\n' "$LABEL" "$summary"; fi
grep -E '^✖ ' "$WORK/.mutate.log" | grep -v 'failing tests:' | sed 's/ ([0-9.]*ms)$//' | sort -u | head -n 3 | sed 's/^/          /'
exit 0
