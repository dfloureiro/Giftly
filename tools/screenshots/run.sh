#!/bin/sh
# Regenerates the README screenshots with mock data, using podman (or docker) and Playwright.
#   tools/screenshots/run.sh            → PNGs in docs/screenshots/
set -eu
cd "$(dirname "$0")/../.."
ENGINE=${ENGINE:-$(command -v podman || command -v docker)}
WORK=$(mktemp -d)
mkdir -p "$WORK/out"
cp tools/screenshots/*.js "$WORK/"
PW=mcr.microsoft.com/playwright:v1.49.1-noble

$ENGINE build -q -t giftly:screenshots . >/dev/null
$ENGINE rm -f giftly-shots >/dev/null 2>&1 || true
$ENGINE volume rm -f giftly-shots-data >/dev/null 2>&1 || true
$ENGINE run -d --name giftly-shots -e ADMIN_USERNAME=emma -e ADMIN_PASSWORD=demo-password-1 -e APP_LANG=en \
  -e LINK_PREVIEWS=false -e BASE_URL=https://giftly.example.com -v giftly-shots-data:/data -p 127.0.0.1:3998:3000 giftly:screenshots >/dev/null
sleep 2
pw() { $ENGINE run --rm --network host --ipc host -v "$WORK":/work:Z -w /work $PW bash -c "$1"; }
pw "npm i -s --no-audit --no-fund playwright@1.49.1 >/dev/null 2>&1 && PHASE=1 node lists.js"
# Demo prices (real ones only come from shop links, which the mock .example links don't have).
$ENGINE exec giftly-shots node -e "
const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/giftly.db');
const P={1:'€89.99',2:'€24.90',4:'€32.00',5:'€45.50',6:'€18.99'};
for(const [id,p] of Object.entries(P)) d.prepare('UPDATE items SET price=?, price_checked_at=? WHERE id=?').run(p,Date.now(),Number(id));" 2>/dev/null
pw "PHASE=2 node lists.js && node give.js && CHECK=${CHECK:-} node wish.js"
if [ -n "${CHECK:-}" ]; then mkdir -p "${CHECK}" && mv "$WORK"/out/check-*.png "${CHECK}/"; fi
cp "$WORK"/out/*.png docs/screenshots/
# The guest-flow video → an optimised GIF for the README.
$ENGINE run --rm -v "$WORK/out":/o:Z docker.io/library/alpine:3.20 sh -c 'apk add -q ffmpeg && ffmpeg -loglevel error -y -i /o/guest-flow.webm \
  -vf "fps=12,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  /o/guest-flow.gif'
cp "$WORK"/out/guest-flow.gif docs/screenshots/
$ENGINE rm -f giftly-shots >/dev/null; $ENGINE volume rm giftly-shots-data >/dev/null
rm -rf "$WORK"
echo "Screenshots updated in docs/screenshots/"
