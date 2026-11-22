#!/bin/sh
set -e
# Started as root: make sure the data dir (often a bind mount) is writable, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec su-exec node "$@"
fi
exec "$@"
