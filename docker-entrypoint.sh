#!/bin/sh
# Runs as root at container start (see Dockerfile - no static `USER` there
# anymore, this script drops privileges itself instead). Needed because a
# Docker named/bind-mounted volume is root-owned by default, and Docker
# only ever initializes a volume's ownership FROM the image on that
# volume's first creation - never on later starts, and never for a volume
# that already exists (e.g. one created before this fix existed). A static
# `USER quniverse` in the Dockerfile can't fix that: chown has to run at
# container START, against whatever the volume's ACTUAL current state is,
# every time - cheap (it's metadata, not a data copy) and idempotent.
set -e

if [ "$(id -u)" = '0' ]; then
  for dir in "$QU_STORE_DIR" "$QU_BLOB_DIR"; do
    if [ -n "$dir" ]; then
      mkdir -p "$dir"
      chown -R quniverse:quniverse "$dir"
    fi
  done
  exec su-exec quniverse "$@"
fi

# Already non-root (e.g. someone set `user:` themselves in compose) - run as-is.
exec "$@"
