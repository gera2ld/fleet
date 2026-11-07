#!/bin/sh
# gomplate plugin exposing fnox as a template function:
#   {{ secret "XRAY_UUID" }}
# gomplate has no shell-out by design, so this is how a docker-scoped secret
# reaches a template: it resolves at render time on the center and never lands
# on disk.
# No trailing newline, so it is safe inside JSON strings. fnox exits 0 with
# empty output on a missing key, so empty is treated as an error here (only the
# name is echoed).
set -eu

val=$(fnox get "$@")
if [ -z "$val" ]; then
  echo "secret: '$*' is not set (or empty) in the vault" >&2
  exit 1
fi
printf '%s' "$val"
