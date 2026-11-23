#!/bin/sh
# End-to-end tests for install.sh against a real Docker (CI, or Docker-in-Docker locally).
# Giftly is the image built from this checkout, served by a local registry (GIFTLY_IMAGE), so
# install.sh pins it by digest exactly as it would ghcr.io. cloudflared is replaced (via
# compose.override.yaml) by a tiny stub that serves /ready on the metrics port only when it got
# a usable TUNNEL_TOKEN, so no real Cloudflare account is needed.
#   sh test/install/run.sh            (from the repository root)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
REG=127.0.0.1:5555
OLD3=ghcr.io/dfloureiro/giftly:3.5.0   # the last 3.x: flat data layout
export GIFTLY_REPO_RAW="file://$ROOT" GIFTLY_YES=1 GIFTLY_READY_TRIES=20 GIFTLY_IMAGE="$REG/giftly" GIFTLY_TAG=4
fails=0
ok() { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# shellcheck disable=SC2012 # fixed file names
mode() { ls -ld "$1" | cut -c1-10; }
cleanup() {
  for d in "$WORK"/*/; do (cd "$d" && docker compose --profile tunnel down -v >/dev/null 2>&1) || true; done
  docker rm -f giftly-test-registry >/dev/null 2>&1 || true
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^($REG/|giftly-test-)" | xargs -r docker rmi -f >/dev/null 2>&1 || true
  # data/ belongs to the container's user (not the runner's): remove it from a container.
  docker run --rm -v "$WORK":/w busybox:1.36 sh -c 'rm -rf /w/*/data' >/dev/null 2>&1 || true
  rm -rf "${WORK:?}" || true
}
trap cleanup EXIT

# The image under test, in a local registry (tag 4), plus a broken variant for the failure cases.
docker run -d --name giftly-test-registry -p "$REG:5000" registry:2 >/dev/null
docker build -q -t giftly-test-good "$ROOT" >/dev/null
GOOD_ID=$(docker image inspect -f '{{.Id}}' giftly-test-good)
publish() { # publish IMAGE TAG: the registry now serves IMAGE under $REG/giftly:TAG
  docker tag "$1" "$REG/giftly:$2" && docker push -q "$REG/giftly:$2" >/dev/null
}
i=0; until publish "$GOOD_ID" 4 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 20 ] || { echo "registry didn't start"; exit 1; }; sleep 1; done
# A new version that upgrades the data into a new release (as a real migration would) and then
# never becomes healthy.
mkdir -p "$WORK/broken"
cat > "$WORK/broken/Dockerfile" <<'DOCKERFILE'
FROM giftly-test-good
CMD ["node", "--input-type=module", "-e", "const r = await import('/app/src/release.js'); const { DatabaseSync } = await import('node:sqlite'); const from = r.ensureData('/data').name; const n = r.buildRelease('/data', { origin: 'upgrade', parent: from, verified_at: 'x' }, (d) => { r.snapshotDb(r.releaseDir('/data', from) + '/giftly.db', d + '/giftly.db'); new DatabaseSync(d + '/giftly.db').exec('CREATE TABLE candidate_was_here (x)'); }); r.switchCurrent('/data', n); process.exit(1);"]
DOCKERFILE
docker build -q -t giftly-test-broken "$WORK/broken" >/dev/null
BROKEN_ID=$(docker image inspect -f '{{.Id}}' giftly-test-broken)

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
in_g() { d=$1; shift; (cd "$WORK/$d" && docker compose exec -T giftly "$@"); }
sql() { # sql DIR DB "query": rows as JSON (DB relative to /data)
  in_g "$1" node -e "const { DatabaseSync } = require('node:sqlite'); console.log(JSON.stringify(new DatabaseSync('/data/' + process.argv[1]).prepare(process.argv[2]).all()))" "$2" "$3"
}
current() { in_g "$1" node /app/scripts/release.js current 2>/dev/null; }
running_image() { (cd "$WORK/$1" && docker inspect -f '{{.Image}}' "$(docker compose ps -q giftly)"); }

# A. Fresh install with a tunnel.
mkdir -p "$WORK/a"; stub "$WORK/a"
if install a GIFTLY_DOMAIN=gifts.example.com TUNNEL_TOKEN=good-token ADMIN_USERNAME=ana; then ok "A: fresh install succeeds"; else bad "A: fresh install succeeds"; cat "$WORK/a.log"; fi
check "A: token only in cloudflared.env" "! grep -q TUNNEL_TOKEN '$WORK/a/.env' && grep -q '^TUNNEL_TOKEN=good-token' '$WORK/a/cloudflared.env'"
check "A: secrets are 600" "[ \"\$(mode '$WORK/a/.env')\" = -rw------- ] && [ \"\$(mode '$WORK/a/cloudflared.env')\" = -rw------- ]"
check "A: no temporary files left" "[ -z \"\$(ls -A '$WORK/a' | grep -e giftly-tmp -e compose.template -e compose.yaml.tmp)\" ]"
check "A: Giftly's container never gets the token" "! (cd '$WORK/a' && docker compose --profile tunnel config) | awk '/^  giftly:/{g=1;next} /^  [a-z]/{g=0} g' | grep -q TUNNEL_TOKEN"
check "A: compose.yaml names both images by digest" "grep -q 'image: $REG/giftly@sha256:' '$WORK/a/compose.yaml' && grep -q 'image: cloudflare/cloudflared@sha256:' '$WORK/a/compose.yaml'"
check "A: data in a release behind data/current, and served" "[ -L '$WORK/a/data/current' ] && in_g a node /app/scripts/served.js --expect \"\$(current a)\" >/dev/null"

down a

# B. An older compose.yaml with local changes: replaced (install.sh manages it now), the local
#    copy kept next to it, and the token moved out of .env.
mkdir -p "$WORK/b"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/b/compose.yaml"; echo "# my change" >> "$WORK/b/compose.yaml"
printf 'ADMIN_USERNAME=b\nADMIN_PASSWORD=bbbbbbbbbbbb\nTUNNEL_TOKEN=good-token\n' > "$WORK/b/.env"; chmod 644 "$WORK/b/.env"; stub "$WORK/b"
if install b; then ok "B: update succeeds"; else bad "B: update succeeds"; cat "$WORK/b.log"; fi
check "B: changed compose.yaml kept aside and replaced" "tail -n 1 \"\$(ls '$WORK'/b/compose.yaml.local-*)\" | grep -q 'my change' && grep -q '@sha256:' '$WORK/b/compose.yaml' && grep -q 'compose.override.yaml' '$WORK/b.log'"
check "B: token migrated" "! grep -q TUNNEL_TOKEN '$WORK/b/.env' && grep -q '^TUNNEL_TOKEN=good-token' '$WORK/b/cloudflared.env'"
check "B: open .env permissions fixed" "[ \"\$(mode '$WORK/b/.env')\" = -rw------- ] && grep -q 'now private' '$WORK/b.log'"

down b

# C. A 3.3 setup whose update fails (the new image can't be pulled). Every file is put back
#    (compose.yaml, .env; cloudflared.env and .compose.sha256 didn't exist → removed) and the
#    previous setup, tunnel included, works again.
mkdir -p "$WORK/c"; cp "$ROOT/test/install/compose-3.3.yaml" "$WORK/c/compose.yaml"
printf 'ADMIN_USERNAME=c\nADMIN_PASSWORD=cccccccccccc\nTUNNEL_TOKEN=good-token\n' > "$WORK/c/.env"; chmod 600 "$WORK/c/.env"; stub "$WORK/c"
cp "$WORK/c/.env" "$WORK/c.env.before"
if install c GIFTLY_TAG=does-not-exist-400; then bad "C: installer reports failure"; cat "$WORK/c.log"; else ok "C: installer reports failure"; fi
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
if install f GIFTLY_TAG=does-not-exist-400 ADMIN_USERNAME=fiona; then bad "F: installer reports failure"; else ok "F: installer reports failure"; fi
check "F: .env kept" "grep -q '^ADMIN_USERNAME=fiona' '$WORK/f/.env'"

down f

# G/H. An update that downloads fine but whose new image (SAME tag) upgrades the data into a new
#      release and then never becomes healthy, with `pull_policy: always` in the override: the
#      exact previous image (digest), the previous data release and the service all come back.
#      G with a tunnel, H without.
same_tag_case() { # same_tag_case DIR LABEL [env...]
  d=$1 label=$2; shift 2
  mkdir -p "$WORK/$d"
  if [ "$label" = G ]; then stub "$WORK/$d"; else echo 'services:' > "$WORK/$d/compose.override.yaml"; fi
  printf '  giftly:\n    pull_policy: always\n' >> "$WORK/$d/compose.override.yaml"
  publish "$GOOD_ID" same
  if install "$d" GIFTLY_TAG=same ADMIN_USERNAME=gina "$@"; then ok "$label: install with the good image"; else bad "$label: install with the good image"; cat "$WORK/$d.log"; return; fi
  in_g "$d" node -e "new (require('node:sqlite').DatabaseSync)('/data/current/giftly.db').exec(\"CREATE TABLE before_update (x); INSERT INTO before_update VALUES ('kept')\")"
  old_id=$(running_image "$d")
  old_release=$(current "$d")
  # The registry now serves the broken image under the same tag.
  publish "$BROKEN_ID" same
  if install "$d" GIFTLY_TAG=same; then bad "$label: installer reports failure"; cat "$WORK/$d.log"; else ok "$label: installer reports failure"; fi
  if grep -q 'restored and is working again' "$WORK/$d.log" && grep -q "back on release $old_release" "$WORK/$d.log"; then ok "$label: says it is working again with the data switched back"
  else bad "$label: says it is working again with the data switched back"; cat "$WORK/$d.log"; fi
  check "$label: running the exact old image again" "[ \"\$(running_image $d)\" = '$old_id' ]"
  check "$label: compose.yaml pins the old digest" "grep -q \"image: \$(docker image inspect -f '{{index .RepoDigests 0}}' '$old_id')\$\" '$WORK/$d/compose.yaml' && ! grep -q 'giftly:same' '$WORK/$d/compose.yaml'"
  check "$label: serves the previous data release" "in_g $d node /app/scripts/served.js --expect '$old_release' >/dev/null && [ \"\$(current $d)\" = '$old_release' ]"
  check "$label: data as before the update" "sql $d current/giftly.db \"SELECT x FROM before_update\" | grep -q kept && ! sql $d current/giftly.db \"SELECT 1 FROM candidate_was_here\" >/dev/null 2>&1"
  check "$label: the failed version's release is kept" "[ \"\$(in_g $d ls /data/releases | wc -l)\" -ge 2 ]"
  if [ "$label" = G ]; then
    check "G: the tunnel works again" "(cd '$WORK/$d' && docker compose exec -T giftly wget -qO- http://cloudflared:20241/ready) >/dev/null 2>&1"
  fi
  down "$d"
}
same_tag_case g G GIFTLY_DOMAIN=gifts.example.com TUNNEL_TOKEN=good-token
same_tag_case h H

# I. From Giftly 3.5 (flat data layout) to 4: the data is copied into a release and served; the
#    flat files stay. A failed 4 then rolls back to the exact 3.5 image, which finds its data.
mkdir -p "$WORK/i"; sed "s|ghcr.io/dfloureiro/giftly:latest|$OLD3|" "$ROOT/test/install/compose-3.3.yaml" > "$WORK/i/compose.yaml"
echo 'services: {}' > "$WORK/i/compose.override.yaml"
printf 'ADMIN_USERNAME=ivo\nADMIN_PASSWORD=iiiiiiiiiiii\n' > "$WORK/i/.env"; chmod 600 "$WORK/i/.env"
(cd "$WORK/i" && docker compose up -d >/dev/null 2>&1)
j=0; until in_g i wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do j=$((j + 1)); [ "$j" -lt 30 ] || break; sleep 1; done
in_g i node -e "new (require('node:sqlite').DatabaseSync)('/data/giftly.db').exec(\"CREATE TABLE from_three (x); INSERT INTO from_three VALUES ('three')\")"
old3_id=$(running_image i)
publish "$BROKEN_ID" bad4
if install i GIFTLY_TAG=bad4; then bad "I: failed 3.5 → 4 reports failure"; cat "$WORK/i.log"; else ok "I: failed 3.5 → 4 reports failure"; fi
check "I: back on the exact 3.5 image, with its data" "[ \"\$(running_image i)\" = '$old3_id' ] && sql i giftly.db 'SELECT x FROM from_three' | grep -q three"
check "I: the failed attempt's current link is gone (4 will copy the 3.5 data again)" "! in_g i test -L /data/current"
if install i; then ok "I: 3.5 → 4 succeeds"; else bad "I: 3.5 → 4 succeeds"; cat "$WORK/i.log"; fi
check "I: the 3.5 data is served from a release" "sql i current/giftly.db 'SELECT x FROM from_three' | grep -q three && in_g i node /app/scripts/served.js >/dev/null"
check "I: the flat 3.5 files are still there" "sql i giftly.db 'SELECT x FROM from_three' | grep -q three"
down i

# J. An update whose configuration mounts a different (empty) folder at /data: Giftly would start
#    healthy, but on empty data. Reported as a failure; the real data is left as it was.
mkdir -p "$WORK/j"; echo 'services: {}' > "$WORK/j/compose.override.yaml"
if install j ADMIN_USERNAME=jo; then ok "J: install"; else bad "J: install"; cat "$WORK/j.log"; fi
in_g j node -e "new (require('node:sqlite').DatabaseSync)('/data/current/giftly.db').exec(\"CREATE TABLE real_data (x); INSERT INTO real_data VALUES ('mine')\")"
printf 'services:\n  giftly:\n    volumes:\n      - ./other:/data\n' > "$WORK/j/compose.override.yaml"
if install j; then bad "J: different /data reported as failure"; cat "$WORK/j.log"; else ok "J: different /data reported as failure"; fi
check "J: says why" "grep -q 'mounts different data' '$WORK/j.log'"
check "J: the real data is untouched" "docker run --rm -v '$WORK/j/data':/data --entrypoint node giftly-test-good -e \"console.log(JSON.stringify(new (require('node:sqlite').DatabaseSync)('/data/current/giftly.db').prepare('SELECT x FROM real_data').all()))\" | grep -q mine"
down j

# K. A setup from before digests (its compose.yaml names a TAG, with pull_policy: always) whose
#    update to that same tag, now moved to a broken image, fails: the rollback must run the exact
#    image that was running, not whatever the tag points to now.
mkdir -p "$WORK/k"; sed "s|ghcr.io/dfloureiro/giftly:latest|$REG/giftly:moving|" "$ROOT/test/install/compose-3.3.yaml" > "$WORK/k/compose.yaml"
printf 'services:\n  giftly:\n    pull_policy: always\n' > "$WORK/k/compose.override.yaml"
printf 'ADMIN_USERNAME=kai\nADMIN_PASSWORD=kkkkkkkkkkkk\n' > "$WORK/k/.env"; chmod 600 "$WORK/k/.env"
publish "$GOOD_ID" moving
(cd "$WORK/k" && docker compose up -d >/dev/null 2>&1)
j=0; until in_g k wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; do j=$((j + 1)); [ "$j" -lt 30 ] || break; sleep 1; done
k_id=$(running_image k)
publish "$BROKEN_ID" moving
if install k GIFTLY_TAG=moving; then bad "K: failed update reports failure"; cat "$WORK/k.log"; else ok "K: failed update reports failure"; fi
check "K: running the exact image from before, not the moved tag" "[ \"\$(running_image k)\" = '$k_id' ] && grep -q 'restored and is working again' '$WORK/k.log'"
down k

if [ "$fails" != 0 ]; then echo "install.sh: $fails check(s) failed"; exit 1; fi
echo "install.sh: all checks passed"
