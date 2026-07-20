#!/usr/bin/env bash
# Guard against Caddy directives that break Server-Sent Events streaming.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CADDYFILE="${1:-$ROOT/ops/caddy/Caddyfile.example}"

test -f "$CADDYFILE"

if grep -Eq 'encode[[:space:]]+.*text/event-stream' "$CADDYFILE"; then
  echo "SSE must not be explicitly encoded: $CADDYFILE" >&2
  exit 1
fi

if grep -Eq 'buffer_requests|request_buffers|response_buffers' "$CADDYFILE"; then
  echo "SSE-incompatible buffering directive found: $CADDYFILE" >&2
  exit 1
fi

grep -Eq 'reverse_proxy' "$CADDYFILE"
echo "sse-streaming-config-ok"
