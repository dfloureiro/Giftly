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
mode() { ls -ld "$1" | cut -c1-10; }
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

# C. A working 3.3 install whose update fails (here: the new image can't be pulled). Every file
#    is put back (compose.yaml, .env; cloudflared.env and .compose.sha256 didn't exist → removed)
#    and the previous setup, tunnel included, works again.
mkdir -p "$WORK/c"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/c/compose.yaml"
printf 'ADMIN_USERNAME=c\nADMIN_PASSWORD=cccccccccccc\nTUNNEL_TOKEN=good-token\n' > "$WORK/c/.env"; chmod 600 "$WORK/c/.env"; stub "$WORK/c"
cp "$WORK/c/.env" "$WORK/c.env.before"
if install c GIFTLY_TAG=does-not-exist-342; then bad "C: installer reports failure"; cat "$WORK/c.log"; else ok "C: installer reports failure"; fi
check "C: compose.yaml back to the 3.3 one" "cmp -s '$WORK/c/compose.yaml' '$ROOT/test/install/compose-3.3.yaml'"
check "C: .env back as it was (token included)" "cmp -s '$WORK/c/.env' '$WORK/c.env.before'"
check "C: files that didn't exist are gone" "[ ! -f '$WORK/c/cloudflared.env' ] && [ ! -f '$WORK/c/.compose.sha256' ]"
check "C: the tunnel works again" "(cd '$WORK/c' && docker compose exec -T giftly wget -qO- http://cloudflared:20241/ready) >/dev/null 2>&1"
check "C: says so" "grep -q 'restored and is working again' '$WORK/c.log'"
check "C: snapshot is private" "[ \"\$(mode '$WORK/c/.giftly-backup')\" = drwx------ ] && [ -n \"\$(find '$WORK/c/.giftly-backup' -type f)\" ] && [ -z \"\$(find '$WORK/c/.giftly-backup' -type f ! -perm 600)\" ]"

down c
# E. The previous setup itself can't start the tunnel (bad token): files restored, and it says
#    clearly that it didn't come back either.
mkdir -p "$WORK/e"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/e/compose.yaml"
printf 'ADMIN_USERNAME=e\nADMIN_PASSWORD=eeeeeeeeeeee\nTUNNEL_TOKEN=bad\n' > "$WORK/e/.env"; chmod 600 "$WORK/e/.env"; stub "$WORK/e"
if install e; then bad "E: installer reports failure"; cat "$WORK/e.log"; else ok "E: installer reports failure"; fi
check "E: files restored, token back in .env" "grep -q '^TUNNEL_TOKEN=bad' '$WORK/e/.env' && [ ! -f '$WORK/e/cloudflared.env' ] && cmp -s '$WORK/e/compose.yaml' '$ROOT/test/install/compose-3.3.yaml'"
check "E: says it didn't come back" "grep -q \"didn't come back either\" '$WORK/e.log'"

down e
# F. A failed FIRST install keeps its .env (the admin account may already use that password).
mkdir -p "$WORK/f"
if install f GIFTLY_TAG=does-not-exist-342 ADMIN_USERNAME=fiona; then bad "F: installer reports failure"; else ok "F: installer reports failure"; fi
check "F: .env kept" "grep -q '^ADMIN_USERNAME=fiona' '$WORK/f/.env'"

down f
# D. The same 3.3 install with a working token: migrated and the tunnel is ready.
mkdir -p "$WORK/d"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/d/compose.yaml"
printf 'ADMIN_USERNAME=d\nADMIN_PASSWORD=dddddddddddd\nTUNNEL_TOKEN=good-token\n' > "$WORK/d/.env"; chmod 600 "$WORK/d/.env"; stub "$WORK/d"
if install d; then ok "D: update succeeds"; else bad "D: update succeeds"; cat "$WORK/d.log"; fi
check "D: token migrated" "! grep -q TUNNEL_TOKEN '$WORK/d/.env' && grep -q '^TUNNEL_TOKEN=good-token' '$WORK/d/cloudflared.env'"
check "D: no backup left behind" "[ -z \"\$(ls -A '$WORK/d' | grep '^.env.backup')\" ]"

down d

if [ "$fails" != 0 ]; then echo "install.sh: $fails check(s) failed"; exit 1; fi
echo "install.sh: all checks passed"
