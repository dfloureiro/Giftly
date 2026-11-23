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
REG=127.0.0.1:5555
SAME=$REG/giftly:same   # one tag, first a good image, then a broken one
cleanup() {
  docker rm -f giftly-test-registry >/dev/null 2>&1 || true
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^(localhost/giftly-rollback|$REG/)" | xargs -r docker rmi >/dev/null 2>&1 || true
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

# G/H. An update that downloads fine but whose new image (same tag) changes the database and then
#      never becomes healthy: the old image, the data and the service all come back; the failed
#      version's data is kept apart. G with a tunnel, H without.
docker run -d --name giftly-test-registry -p "$REG:5000" registry:2 >/dev/null
docker pull -q "ghcr.io/dfloureiro/giftly:$GIFTLY_TAG" >/dev/null
GOOD_ID=$(docker image inspect -f '{{.Id}}' "ghcr.io/dfloureiro/giftly:$GIFTLY_TAG")
mkdir -p "$WORK/broken"
cat > "$WORK/broken/Dockerfile" <<'DOCKERFILE'
ARG BASE
FROM ${BASE}
# Changes the data like a migration would, then fails.
CMD ["node", "-e", "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync('/data/giftly.db').exec('CREATE TABLE candidate_was_here (x)'); process.exit(1)"]
DOCKERFILE
docker build -q --build-arg BASE="ghcr.io/dfloureiro/giftly:$GIFTLY_TAG" -t giftly-test-broken "$WORK/broken" >/dev/null
publish() { # publish IMAGE-ID: push it as $SAME (the registry now serves it under that tag)
  docker tag "$1" "$SAME" && docker push -q "$SAME" >/dev/null
}
sql() { # sql DIR "query": run a query in that install's Giftly, print the rows
  (cd "$WORK/$1" && docker compose exec -T giftly node -e "const { DatabaseSync } = require('node:sqlite'); console.log(JSON.stringify(new DatabaseSync('/data/giftly.db').prepare(process.argv[1]).all()))" "$2")
}
same_tag_case() { # same_tag_case DIR LABEL [env...]
  d=$1 label=$2; shift 2
  mkdir -p "$WORK/$d"
  # The image comes from the override (installer never touches it); G also gets the tunnel stub.
  if [ "$label" = G ]; then stub "$WORK/$d"; else echo 'services:' > "$WORK/$d/compose.override.yaml"; fi
  printf '  giftly:\n    image: %s\n' "$SAME" >> "$WORK/$d/compose.override.yaml"
  publish "$GOOD_ID"
  if install "$d" ADMIN_USERNAME=gina "$@"; then ok "$label: install with the good image"; else bad "$label: install with the good image"; cat "$WORK/$d.log"; return; fi
  (cd "$WORK/$d" && docker compose exec -T giftly node -e "new (require('node:sqlite').DatabaseSync)('/data/giftly.db').exec(\"CREATE TABLE before_update (x); INSERT INTO before_update VALUES ('kept')\")")
  old_id=$(cd "$WORK/$d" && docker inspect -f '{{.Image}}' "$(docker compose ps -q giftly)")
  # The registry now serves the broken image under the same tag; this machine still has the good one.
  publish "$(docker image inspect -f '{{.Id}}' giftly-test-broken)"
  docker tag "$old_id" "$SAME"
  if install "$d"; then bad "$label: installer reports failure"; cat "$WORK/$d.log"; else ok "$label: installer reports failure"; fi
  if grep -q 'restored and is working again' "$WORK/$d.log" && grep -q 'failed-upgrade-' "$WORK/$d.log"; then ok "$label: says it is working again with the data put back"
  else bad "$label: says it is working again with the data put back"; cat "$WORK/$d.log"; fi
  check "$label: running the exact old image again" "[ \"\$(cd '$WORK/$d' && docker inspect -f '{{.Image}}' \"\$(docker compose ps -q giftly)\")\" = '$old_id' ]"
  check "$label: the tag points to the old image again" "[ \"\$(docker image inspect -f '{{.Id}}' '$SAME')\" = '$old_id' ]"
  check "$label: data as before the update" "sql $d \"SELECT x FROM before_update\" | grep -q kept && ! sql $d \"SELECT 1 FROM candidate_was_here\" >/dev/null 2>&1"
  check "$label: the failed version's data is kept" "(cd '$WORK/$d' && docker compose exec -T giftly node -e \"new (require('node:sqlite').DatabaseSync)(require('node:fs').globSync('/data/failed-upgrade-*/giftly.db')[0]).prepare('SELECT 1 FROM candidate_was_here').all()\")"
  check "$label: the recovery point is still there" "(cd '$WORK/$d' && docker compose exec -T giftly sh -c 'ls /data/pre-upgrade-*/giftly.db') >/dev/null 2>&1"
  check "$label: Giftly answers" "(cd '$WORK/$d' && docker compose exec -T giftly wget -qO- http://127.0.0.1:3000/healthz) >/dev/null 2>&1"
  if [ "$label" = G ]; then
    check "G: the tunnel works again" "(cd '$WORK/$d' && docker compose exec -T giftly wget -qO- http://cloudflared:20241/ready) >/dev/null 2>&1"
  fi
  down "$d"
}
same_tag_case g G GIFTLY_DOMAIN=gifts.example.com TUNNEL_TOKEN=good-token
same_tag_case h H

if [ "$fails" != 0 ]; then echo "install.sh: $fails check(s) failed"; exit 1; fi
echo "install.sh: all checks passed"
