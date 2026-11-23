#!/bin/sh
# End-to-end tests for install.sh against a real Docker (CI, or Docker-in-Docker locally).
# cloudflared is replaced (via compose.override.yaml) by a tiny stub that serves /ready on the
# metrics port only when it got a usable TUNNEL_TOKEN, so no real Cloudflare account is needed.
#   sh test/install/run.sh            (from the repository root)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
export GIFTLY_REPO_RAW="file://$ROOT" GIFTLY_YES=1 GIFTLY_READY_TRIES=20 GIFTLY_TAG="${GIFTLY_TAG:-3}"
fails=0
ok() { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# shellcheck disable=SC2012 # fixed file names
mode() { ls -l "$1" | cut -c1-10; }
cleanup() {
  for d in "$WORK"/*/; do (cd "$d" && docker compose --profile tunnel down -v >/dev/null 2>&1) || true; done
  # data/ belongs to the container's user (not the runner's): remove it from a container.
  docker run --rm -v "$WORK":/w busybox:1.36 sh -c 'rm -rf /w/*/data' >/dev/null 2>&1 || true
  rm -rf "${WORK:?}" || true
}
trap cleanup EXIT

stub() { # stub DIR: the fake cloudflared (ready only with a token that isn't "bad")
  cat > "$1/compose.override.yaml" <<'YAML'
services:
  cloudflared:
    image: busybox:1.36
    command: ["sh", "-c", "[ -n \"$$TUNNEL_TOKEN\" ] && [ \"$$TUNNEL_TOKEN\" != bad ] && mkdir -p /w && echo ok > /w/ready && exec httpd -f -p 20241 -h /w || { echo no token; exit 1; }", "stub", "--metrics"]
    restart: "no"
YAML
}
down() { (cd "$WORK/$1" && docker compose --profile tunnel down >/dev/null 2>&1) || true; } # free the port
install() { # install DIR [env...]: run the installer there; output in DIR.log
  d=$1; shift
  (cd "$WORK" && env GIFTLY_DIR="$d" "$@" sh "$ROOT/install.sh") > "$WORK/$d.log" 2>&1
}

# A. Fresh install with a tunnel.
mkdir -p "$WORK/a"; stub "$WORK/a"
if install a GIFTLY_DOMAIN=gifts.example.com TUNNEL_TOKEN=good-token ADMIN_USERNAME=ana; then ok "A: fresh install succeeds"; else bad "A: fresh install succeeds"; cat "$WORK/a.log"; fi
check "A: token only in cloudflared.env" "! grep -q TUNNEL_TOKEN '$WORK/a/.env' && grep -q '^TUNNEL_TOKEN=good-token' '$WORK/a/cloudflared.env'"
check "A: secrets are 600" "[ \"\$(mode '$WORK/a/.env')\" = -rw------- ] && [ \"\$(mode '$WORK/a/cloudflared.env')\" = -rw------- ]"
check "A: no temporary files left" "[ -z \"\$(ls -A '$WORK/a' | grep giftly-tmp)\" ]"
check "A: Giftly's container never gets the token" "! (cd '$WORK/a' && docker compose --profile tunnel config) | awk '/^  giftly:/{g=1;next} /^  [a-z]/{g=0} g' | grep -q TUNNEL_TOKEN"

down a

# B. An older, customised compose.yaml that hands cloudflared the token from .env: kept, not migrated.
mkdir -p "$WORK/b"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/b/compose.yaml"; echo "# my change" >> "$WORK/b/compose.yaml"
printf 'ADMIN_USERNAME=b\nADMIN_PASSWORD=bbbbbbbbbbbb\nTUNNEL_TOKEN=good-token\n' > "$WORK/b/.env"; chmod 644 "$WORK/b/.env"; stub "$WORK/b"
if install b; then ok "B: update succeeds"; else bad "B: update succeeds"; cat "$WORK/b.log"; fi
check "B: modified compose.yaml kept" "tail -n 1 '$WORK/b/compose.yaml' | grep -q 'my change' && [ -f '$WORK/b/compose.yaml.new' ]"
check "B: token not migrated, still in .env" "grep -q '^TUNNEL_TOKEN=good-token' '$WORK/b/.env' && [ ! -f '$WORK/b/cloudflared.env' ]"
check "B: says what to change" "grep -q 'TUNNEL_TOKEN stays in .env' '$WORK/b.log'"
check "B: open .env permissions fixed" "[ \"\$(mode '$WORK/b/.env')\" = -rw------- ] && grep -q 'now private' '$WORK/b.log'"

down b

# C. A 3.3 install (official compose, token in .env) whose tunnel then doesn't come up: rolled back.
mkdir -p "$WORK/c"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/c/compose.yaml"
printf 'ADMIN_USERNAME=c\nADMIN_PASSWORD=cccccccccccc\nTUNNEL_TOKEN=bad\n' > "$WORK/c/.env"; chmod 600 "$WORK/c/.env"; stub "$WORK/c"
if install c; then bad "C: installer reports failure"; cat "$WORK/c.log"; else ok "C: installer reports failure"; fi
check "C: compose.yaml was updated (it was the official one)" "cmp -s '$WORK/c/compose.yaml' '$ROOT/compose.yaml'"
check "C: .env restored with the token" "grep -q '^TUNNEL_TOKEN=bad' '$WORK/c/.env' && [ ! -f '$WORK/c/cloudflared.env' ]"
check "C: clear message" "grep -q \"Tunnel didn't connect\" '$WORK/c.log' && grep -q 'previous .env was put back' '$WORK/c.log'"

down c

# D. The same 3.3 install with a working token: migrated and the tunnel is ready.
mkdir -p "$WORK/d"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/d/compose.yaml"
printf 'ADMIN_USERNAME=d\nADMIN_PASSWORD=dddddddddddd\nTUNNEL_TOKEN=good-token\n' > "$WORK/d/.env"; chmod 600 "$WORK/d/.env"; stub "$WORK/d"
if install d; then ok "D: update succeeds"; else bad "D: update succeeds"; cat "$WORK/d.log"; fi
check "D: token migrated" "! grep -q TUNNEL_TOKEN '$WORK/d/.env' && grep -q '^TUNNEL_TOKEN=good-token' '$WORK/d/cloudflared.env'"
check "D: no backup left behind" "[ -z \"\$(ls -A '$WORK/d' | grep '^.env.backup')\" ]"

down d

if [ "$fails" != 0 ]; then echo "install.sh: $fails check(s) failed"; exit 1; fi
echo "install.sh: all checks passed"
