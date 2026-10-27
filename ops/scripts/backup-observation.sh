#!/usr/bin/env bash
# Stable host observation entrypoint; schema/time/fsync use the shared Node 22 implementation.
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec node "$SCRIPT_DIR/backup-observation-writer.mjs" "$@"
