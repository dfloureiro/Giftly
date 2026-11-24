#!/bin/sh
# Giftly one-step install: Docker Compose + (optionally) a Cloudflare Tunnel.
#
#   curl -fsSL https://raw.githubusercontent.com/dfloureiro/Giftly/main/install.sh -o install.sh
#   sh install.sh
#
# Asks for your domain and Cloudflare Tunnel token (both optional), writes .env with a strong
# admin password (and cloudflared.env with the token, which Giftly itself never sees), starts
# everything, checks that it really works and prints how to log in. Files come from the latest
# release, not from main.
#
# Re-running it updates and restarts. compose.yaml is managed by this script: it names the
# images by digest (the exact image, never a tag that can move), and is rewritten on every
# update; put your own changes in compose.override.yaml, which it never touches. It never
# overwrites .env or cloudflared.env. Giftly itself keeps your data safe across updates (a
# database upgrade runs on a new copy, in /data/releases/). If the update leaves Giftly or the
# tunnel down, or Giftly doesn't serve your data, it puts back your settings, the exact images
# that worked (by digest) and the data release they used, checks them, and says so.
#
# Non-interactive: set GIFTLY_DOMAIN, TUNNEL_TOKEN, ADMIN_USERNAME (and GIFTLY_DIR, GIFTLY_PORT)
# in the environment, and GIFTLY_YES=1 to skip the questions. GIFTLY_TAG (also read from .env)
# picks the version to follow (default: 4); GIFTLY_IMAGE another image repository.
set -eu

REPO=dfloureiro/Giftly
DIR=${GIFTLY_DIR:-giftly}
PORT=${GIFTLY_PORT:-3000}
READY_TRIES=${GIFTLY_READY_TRIES:-45}   # seconds to wait for Giftly and for the tunnel
PROBE=__giftly_install_probe__

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" "default"
  eval "cur=\${$1:-}"
  if [ -n "$cur" ] || [ "${GIFTLY_YES:-}" = 1 ] || [ ! -r /dev/tty ]; then return; fi
  printf '%s ' "$2" >/dev/tty
  # shellcheck disable=SC2034 # read by the eval below
  read -r ans </dev/tty || ans=''
  eval "$1=\${ans:-\$3}"
}

# Secrets are only ever written privately and atomically: a 0600 temporary file in the same
# folder (mktemp), then mv over the target. Content comes from stdin.
write_secret() {
  tmp=$(umask 077 && mktemp ./.giftly-tmp.XXXXXX) || die "can't create a temporary file in $(pwd)"
  if ! cat > "$tmp"; then rm -f "$tmp"; die "can't write $1"; fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$1"
}
# Any group/other permission on a secrets file is removed (with a note).
lock_down() {
  for f in "$@"; do
    [ -f "$f" ] || continue
    # shellcheck disable=SC2012 # fixed file names; ls -l reads permissions the same everywhere
    case "$(ls -l "$f" | cut -c5-10)" in
      ------) ;;
      *) chmod 600 "$f"; say "Note: $f was readable by other users; it is now private (600)." ;;
    esac
  done
}

# --- Docker -------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then COMPOSE='docker compose'
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE='docker-compose'
else die "Docker Compose is not installed. See https://docs.docker.com/compose/install/"; fi
docker info >/dev/null 2>&1 || die "can't talk to Docker. Is it running? (You may need sudo, or to be in the docker group.)"

# --- Files --------------------------------------------------------------------------------
mkdir -p "$DIR"
cd "$DIR"
fetch() { # fetch URL FILE ("-" = stdout)
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-64; }
lock_down .env cloudflared.env
rm -f ./.giftly-tmp.?????? # leftovers of an interrupted earlier run

# --- Images by digest -------------------------------------------------------------------------
repo_of() { # repository of an image reference (without :tag or @digest)
  r=${1%@*}
  case "${r##*/}" in *:*) r=${r%:*} ;; esac
  printf '%s\n' "$r"
}
digest_of() { # digest_of REF-OR-ID [REPO]: repo@sha256:… of a local image, or nothing
  case "$1" in *@sha256:*) printf '%s\n' "$1"; return ;; esac
  repo=${2:-$(repo_of "$1")}
  docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | grep "^$repo@sha256:" | head -n 1
}
# Write compose.yaml from a compose file, with the image of the giftly and cloudflared services
# replaced by the given references (empty = left as it is).
pin_images() { # pin_images SOURCE GIFTLY-REF CLOUDFLARED-REF
  awk -v g="$2" -v c="$3" '
    /^[^ #]/ { top = $1 }
    top == "services:" && /^  [A-Za-z0-9_.-]+:[ \t]*$/ { svc = $1; sub(/:$/, "", svc) }
    top == "services:" && /^    image:/ {
      if (svc == "giftly" && g != "") sub(/image:.*/, "image: " g)
      else if (svc == "cloudflared" && c != "") sub(/image:.*/, "image: " c)
    }
    { print }' "$1" > .compose.yaml.tmp && mv .compose.yaml.tmp compose.yaml
}
data_mount() { # where a container's /data comes from
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}} {{.Source}} {{.Name}}{{end}}{{end}}' "$1" 2>/dev/null
}

# --- Snapshot ------------------------------------------------------------------------------
# Every file this script may change, saved before it changes anything (and which ones didn't
# exist yet), and the exact images (digests) the current containers run, so a failed update
# can put back exactly the setup that worked. Private folder; the last 3 snapshots are kept.
SNAP_FILES='compose.yaml compose.override.yaml .env cloudflared.env .compose.sha256'
SNAP_NAME="$(date +%Y%m%d-%H%M%S)-$$"
SNAP=".giftly-backup/$SNAP_NAME"
HAD_INSTALL=0
[ -f .env ] && HAD_INSTALL=1
(umask 077 && mkdir -p "$SNAP")
chmod 700 .giftly-backup "$SNAP"
for f in $SNAP_FILES; do
  if [ -f "$f" ]; then cp "$f" "$SNAP/$f" && chmod 600 "$SNAP/$f"; else echo "$f" >> "$SNAP/.absent"; fi
done
chmod 600 "$SNAP/.absent" 2>/dev/null || true
#   .images: "service  digest" (the exact image each running service used)
OLD_ID=''
OLD_MOUNT=''
if [ "$HAD_INSTALL" = 1 ] && [ -f compose.yaml ]; then
  for svc in giftly cloudflared; do
    cid=$($COMPOSE --profile tunnel ps -aq "$svc" 2>/dev/null | head -n 1) || cid=''
    [ -n "$cid" ] || continue
    ref=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null) || continue
    id=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null) || continue
    digest=$(digest_of "$id" "$(repo_of "$ref")")
    printf '%s %s\n' "$svc" "${digest:-none}" >> "$SNAP/.images"
    if [ "$svc" = giftly ]; then OLD_ID=$id; OLD_MOUNT=$(data_mount "$cid"); fi
  done
fi
chmod 600 "$SNAP/.images" 2>/dev/null || true
# shellcheck disable=SC2012 # our own timestamped folder names
for d in $(ls -1d .giftly-backup/*/ 2>/dev/null | sort -r | tail -n +4); do
  # (Before 4.0, snapshots also kept private image tags; remove those with their snapshot.)
  for svc in giftly cloudflared; do docker rmi "localhost/giftly-rollback:$svc-$(basename "$d")" >/dev/null 2>&1 || true; done
  rm -rf "${d:?}"
done

# Files from the latest release (a fixed tag), unless GIFTLY_REPO_RAW points elsewhere.
if [ -n "${GIFTLY_REPO_RAW:-}" ]; then
  REPO_RAW=$GIFTLY_REPO_RAW
else
  TAG=$(fetch "https://api.github.com/repos/$REPO/releases/latest" - 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1) || TAG=''
  [ -n "$TAG" ] || die "couldn't find the latest Giftly release (is GitHub reachable?)"
  REPO_RAW="https://raw.githubusercontent.com/$REPO/$TAG"
  say "Giftly $TAG"
fi
fetch "$REPO_RAW/compose.yaml" .compose.template || die "couldn't download compose.yaml"

# compose.yaml is managed here from now on. A copy you changed is kept next to it (and in the
# snapshot); your changes belong in compose.override.yaml.
if [ -f compose.yaml ]; then
  current=$(sha compose.yaml)
  if [ ! -f .compose.sha256 ] || [ "$current" != "$(cat .compose.sha256)" ]; then
    case "$current" in
      10f10e1706af00a29972946527f578b49e38d052bd8f90f8d84fdff8bf2d7fce|9d43d63e5d4eddc1f90dc0af7e3732057adfbab1ba7eb7d2705dc2c8a86d658e|26383f047c300561b626778df8fa31cde2e0c28000ddef5aa588e999b0f8d698|6833f6f60b58fc87c48f2c5ef88f8ed18acc877d4d7ae4f1d248f2a7d50d00e6|9ef514f9cdfdf9ee3d2ff93deb8dda44f706c1f6f45172725c2298bc7986f9b4) ;;
      *) cp compose.yaml "compose.yaml.local-$SNAP_NAME"
         say "Note: your compose.yaml had local changes. It is now managed by install.sh; your version is kept"
         say "  as compose.yaml.local-$SNAP_NAME. Move your changes to compose.override.yaml." ;;
    esac
  fi
fi
if [ -f compose.override.yaml ] && grep -q '^ *image:' compose.override.yaml; then
  say "Note: compose.override.yaml sets an image. Services whose image it sets don't use the pinned"
  say "  digests, and a rollback can't guarantee their exact previous image."
fi

# Does the ACTIVE configuration (compose.yaml + compose.override.yaml) give cloudflared its
# settings from cloudflared.env? Checked with a harmless probe value, never assumed.
cloudflared_reads_env_file() {
  had=0; [ -f cloudflared.env ] && had=1
  [ "$had" = 1 ] || printf 'TUNNEL_TOKEN=%s\n' "$PROBE" | write_secret cloudflared.env
  if $COMPOSE --profile tunnel config 2>/dev/null | grep -q "$PROBE"; then ok=0; else ok=1; fi
  [ "$had" = 1 ] || rm -f cloudflared.env
  return "$ok"
}
# Which compose profile the files on disk call for (a tunnel token anywhere → the tunnel).
profile_now() {
  if { [ -f cloudflared.env ] && grep -q '^TUNNEL_TOKEN=.' cloudflared.env; } || grep -q '^TUNNEL_TOKEN=.' .env 2>/dev/null
  then echo '--profile tunnel'; fi
}

# --- Checks ---------------------------------------------------------------------------------
# healthy: Giftly answers, serves real data (the expected release, if given), and (with a
# tunnel) cloudflared is connected. Sets REASON otherwise.
in_giftly() { $COMPOSE exec -T giftly "$@" >/dev/null 2>&1; }
healthy() { # healthy [EXPECTED-RELEASE]
  REASON=''
  i=0
  until in_giftly wget -qO- "http://127.0.0.1:3000/healthz"; do
    i=$((i + 1))
    if [ "$i" -ge "$READY_TRIES" ]; then REASON="Giftly didn't start"; return 1; fi
    sleep 1
  done
  # Giftly 4+: the data it serves. /healthz alone also passes on an empty database.
  if in_giftly test -f /app/scripts/served.js; then
    i=0
    until in_giftly node /app/scripts/served.js ${1:+--expect "$1"}; do
      i=$((i + 1))
      if [ "$i" -ge "$READY_TRIES" ]; then
        if [ -n "${1:-}" ]; then REASON="Giftly isn't serving the expected data (release $1)"; else REASON="Giftly isn't serving verified data"; fi
        return 1
      fi
      sleep 1
    done
  fi
  [ -n "$PROFILE" ] || return 0
  # cloudflared answers /ready (metrics port, inside the Docker network) once it is connected
  # to Cloudflare. Older or custom compose files may not expose it: then it must at least be
  # running steadily (not restarting for lack of a token).
  if $COMPOSE --profile tunnel config 2>/dev/null | grep -q -- '--metrics'; then
    i=0
    until in_giftly wget -qO- "http://cloudflared:20241/ready"; do
      i=$((i + 1))
      if [ "$i" -ge "$READY_TRIES" ]; then REASON="the Cloudflare Tunnel didn't connect"; return 1; fi
      sleep 1
    done
  else
    sleep 5
    state=$($COMPOSE --profile tunnel ps cloudflared --format '{{.State}}' 2>/dev/null | head -n 1)
    if [ "$state" != running ]; then REASON="cloudflared isn't running (${state:-stopped})"; return 1; fi
  fi
  return 0
}

# Giftly's release tool, in a container with the giftly service's /data (running or not).
release_tool() { # release_tool IMAGE ARGS...
  img=$1; shift
  cid=$($COMPOSE ps -aq giftly 2>/dev/null | head -n 1)
  [ -n "$cid" ] || return 1
  docker run --rm --network none --volumes-from "$cid" --entrypoint node "$img" \
    --disable-warning=ExperimentalWarning /app/scripts/release.js "$@"
}

# A failed update: put back every file from the snapshot (and remove those that didn't exist),
# the data release the previous version served, and the exact images (by digest) it ran; then
# start it and check that it serves that data again. A failed FIRST install is not rolled back:
# Giftly may already have created the admin account with the password in .env.
PREV_RELEASE=''
NEW_IMAGE=''
OLD_RELEASES=0
rollback() {
  reason=$1
  if [ "$HAD_INSTALL" != 1 ]; then die "$reason"; fi
  say "The update failed ($reason). Putting your previous setup back…"
  # shellcheck disable=SC2086
  $COMPOSE --profile tunnel stop >/dev/null 2>&1 || true
  DATA_NOTE=''
  if [ "$OLD_RELEASES" = 0 ] && [ -n "$OLD_ID" ] && [ -n "$NEW_IMAGE" ]; then
    # Back to Giftly 3.x: it uses the flat files in /data, which 4 never changed. Without the
    # current link, the next Giftly 4 copies them again (rather than reuse this attempt's copy).
    release_tool "$NEW_IMAGE" detach >/dev/null 2>&1 || true
  elif [ -n "$PREV_RELEASE" ] && [ -n "$NEW_IMAGE" ]; then
    now=$(release_tool "$NEW_IMAGE" current 2>/dev/null) || now=''
    if [ "$now" != "$PREV_RELEASE" ]; then
      release_tool "$NEW_IMAGE" switch "$PREV_RELEASE" >/dev/null \
        || die "the update failed: $reason. Switching the data back to release $PREV_RELEASE failed too, so Giftly was left stopped. Nothing was deleted: point data/current to releases/$PREV_RELEASE (see the README, 'Rolling back by hand'). Settings snapshot: $(pwd)/$SNAP"
      DATA_NOTE=" The data is back on release $PREV_RELEASE; the failed version's data stays in data/releases/$now."
    fi
  fi
  for f in $SNAP_FILES; do
    if [ -f "$SNAP/$f" ]; then cp "$SNAP/$f" "$f"; fi
  done
  if [ -f "$SNAP/.absent" ]; then while read -r f; do rm -f "./$f"; done < "$SNAP/.absent"; fi
  chmod 600 .env 2>/dev/null || true
  [ -f cloudflared.env ] && chmod 600 cloudflared.env
  # The exact previous images: pinned by digest in compose.yaml (pulling a digest can only ever
  # return that same image), and present locally before anything starts.
  g=''; c=''
  if [ -f "$SNAP/.images" ]; then
    while read -r svc digest; do
      [ "$digest" != none ] || die "the update failed: $reason. Your previous files are back, but the image $svc ran has no registry digest, so it can't be pinned; nothing was started. Start it yourself: cd $(pwd) && $COMPOSE up -d"
      if ! docker image inspect "$digest" >/dev/null 2>&1 && ! docker pull -q "$digest" >/dev/null 2>&1; then
        die "the update failed: $reason. The image $svc ran before ($digest) is neither on this machine nor in the registry any more, so nothing was started. Your previous files are back (snapshot: $(pwd)/$SNAP)${PREV_RELEASE:+, and the data is on release $PREV_RELEASE}. Install a version you trust with GIFTLY_TAG=<version> sh install.sh"
      fi
      case "$svc" in giftly) g=$digest ;; cloudflared) c=$digest ;; esac
    done < "$SNAP/.images"
  fi
  if [ -n "$g$c" ]; then pin_images compose.yaml "$g" "$c" && sha compose.yaml > .compose.sha256; fi
  PROFILE=$(profile_now)
  # Pinned images are all here already; with nothing recorded (no previous containers), whatever
  # the restored files name is downloaded if needed.
  pull=never; [ -n "$g$c" ] || pull=missing
  # shellcheck disable=SC2086
  if $COMPOSE $PROFILE up -d --pull "$pull" >/dev/null 2>&1 && healthy "$PREV_RELEASE"; then
    die "the update failed: $reason. Your previous setup was restored and is working again, with the same images and data (snapshot: $(pwd)/$SNAP).$DATA_NOTE"
  fi
  die "the update failed: $reason. Your previous files were restored from $(pwd)/$SNAP, but it didn't come back either ($REASON).$DATA_NOTE Logs: cd $(pwd) && $COMPOSE logs"
}

FRESH=0
if [ -f .env ]; then
  say "Using the existing $(pwd)/.env (not changed)."
else
  FRESH=1
  say "Giftly setup. Press Enter to skip a question."
  ask GIFTLY_DOMAIN 'Domain for Giftly (e.g. gifts.example.com, empty = only this computer):' ''
  GIFTLY_DOMAIN=$(printf '%s' "${GIFTLY_DOMAIN:-}" | sed -e 's|^https\{0,1\}://||' -e 's|/.*$||')
  if [ -n "$GIFTLY_DOMAIN" ]; then
    ask TUNNEL_TOKEN 'Cloudflare Tunnel token (empty = no tunnel):' ''
  fi
  ask ADMIN_USERNAME 'Admin username [admin]:' 'admin'
  ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
  PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  {
    say "# Created by install.sh. ADMIN_* only create the first account; you can remove them after."
    say "ADMIN_USERNAME=$ADMIN_USERNAME"
    say "ADMIN_PASSWORD=$PASSWORD"
    [ -n "$GIFTLY_DOMAIN" ] && say "BASE_URL=https://$GIFTLY_DOMAIN"
    [ "$PORT" != 3000 ] && say "GIFTLY_PORT=$PORT"
    say "# Other settings: https://github.com/dfloureiro/Giftly#configuration"
  } | write_secret .env
  if [ -n "${TUNNEL_TOKEN:-}" ]; then
    say "TUNNEL_TOKEN=$TUNNEL_TOKEN" | write_secret cloudflared.env
  fi
fi

# --- Resolve the images to digests (downloads them; the current version keeps running) -------
GIFTLY_TAG=${GIFTLY_TAG:-$(sed -n 's/^GIFTLY_TAG=//p' .env | tail -n 1)}
GIFTLY_TAG=${GIFTLY_TAG:-5}
GIFTLY_REF="${GIFTLY_IMAGE:-ghcr.io/dfloureiro/giftly}:$GIFTLY_TAG"
CLOUDFLARED_REF=$(awk '/^  cloudflared:/{c=1} c && /^    image:/{print $2; exit}' .compose.template)
pin_images .compose.template '' ''   # the release's compose.yaml, still with tags
# Before 3.4 the tunnel token lived in .env (so Giftly saw it too). Move it to cloudflared.env,
# but only if the active configuration reads it from there (the snapshot can undo it).
if grep -q '^TUNNEL_TOKEN=.' .env && [ ! -f cloudflared.env ]; then
  if cloudflared_reads_env_file; then
    grep '^TUNNEL_TOKEN=' .env | write_secret cloudflared.env
    grep -v '^TUNNEL_TOKEN=' .env | write_secret .env
    say "Moved TUNNEL_TOKEN from .env to cloudflared.env (only cloudflared gets it now)."
  else
    say "Note: TUNNEL_TOKEN stays in .env, because your compose.override.yaml gives it to cloudflared from there."
    say "  To keep the token away from Giftly: give the cloudflared service 'env_file: cloudflared.env' there"
    say "  (and no TUNNEL_TOKEN under 'environment'), move the TUNNEL_TOKEN=... line from .env to"
    say "  cloudflared.env, and run this script again."
  fi
fi
PROFILE=$(profile_now)

say "Downloading $GIFTLY_REF…"
docker pull -q "$GIFTLY_REF" >/dev/null 2>&1 || rollback "couldn't download $GIFTLY_REF"
NEW_IMAGE=$(digest_of "$GIFTLY_REF")
[ -n "$NEW_IMAGE" ] || rollback "couldn't find the digest of $GIFTLY_REF"
CLOUDFLARED_PIN=''
if [ -n "$PROFILE" ] && [ -n "$CLOUDFLARED_REF" ]; then
  docker pull -q "$CLOUDFLARED_REF" >/dev/null 2>&1 || rollback "couldn't download $CLOUDFLARED_REF"
  CLOUDFLARED_PIN=$(digest_of "$CLOUDFLARED_REF")
  [ -n "$CLOUDFLARED_PIN" ] || rollback "couldn't find the digest of $CLOUDFLARED_REF"
fi
pin_images .compose.template "$NEW_IMAGE" "$CLOUDFLARED_PIN"
rm -f .compose.template
sha compose.yaml > .compose.sha256
say "Images: $NEW_IMAGE${CLOUDFLARED_PIN:+ and $CLOUDFLARED_PIN}"

# The data release the current Giftly serves: the update must serve it (or its upgrade), and a
# rollback goes back to it. None yet on a first install, or from Giftly 3.x (its data stays
# where it is, untouched, and Giftly 4 copies it into its first release).
OLD_RELEASES=0
if [ -n "$OLD_ID" ] && docker run --rm --network none --entrypoint test "$OLD_ID" -f /app/scripts/release.js >/dev/null 2>&1; then
  OLD_RELEASES=1
  PREV_RELEASE=$(release_tool "$NEW_IMAGE" current 2>/dev/null) || PREV_RELEASE=''
fi

# --- Start ----------------------------------------------------------------------------------
say "Starting Giftly…"
# Images named by digest: pulling one (pull_policy: always included) can only return that image.
# shellcheck disable=SC2086
$COMPOSE $PROFILE up -d --pull missing || rollback "couldn't start the containers"
if [ -n "$OLD_MOUNT" ]; then
  NEW_CID=$($COMPOSE ps -aq giftly 2>/dev/null | head -n 1)
  [ "$(data_mount "$NEW_CID")" = "$OLD_MOUNT" ] || rollback "the new setup mounts different data at /data than before ($OLD_MOUNT)"
fi
healthy "$PREV_RELEASE" || rollback "$REASON"

URL=$(sed -n 's/^BASE_URL=//p' .env | tail -n 1)
PORT=$(sed -n 's/^GIFTLY_PORT=//p' .env | tail -n 1)
PORT=${PORT:-3000}
PUBLIC=''
if [ -n "$URL" ] && command -v curl >/dev/null 2>&1; then
  # Only a hint: on a first install the public hostname may not be set up in Cloudflare yet.
  if curl -fsS -m 10 "$URL/healthz" >/dev/null 2>&1; then PUBLIC=ok; else PUBLIC=down; fi
fi

say ""
say "Giftly is running."
say "  On this computer: http://localhost:$PORT/admin"
if [ -n "$URL" ]; then
  say "  On the internet:  $URL/admin"
  if [ "$PUBLIC" = down ]; then
    if [ -n "$PROFILE" ]; then
      say "    (not reachable yet: in Cloudflare, the tunnel's public hostname must point to http://giftly:3000)"
    else
      say "    (not reachable yet: point your reverse proxy or tunnel to port $PORT)"
    fi
  fi
fi
if [ "$FRESH" = 1 ]; then
  say "  Username: $ADMIN_USERNAME"
  say "  Password: $PASSWORD"
  say "Keep this password: it's also in $(pwd)/.env (readable only by you)."
fi
if [ -n "$PREV_RELEASE" ]; then
  say "  Your data before this update: data/releases/$PREV_RELEASE (the last 3 releases are kept)."
fi
say "Update later: run this script again."
