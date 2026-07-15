#!/usr/bin/env bash
# Validate tunnel Caddyfile with pinned Caddy image (hard gate when docker available).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$ROOT/ops/caddy/Caddyfile.tunnel.example"

test -f "$CONFIG"

grep -F 'bind 127.0.0.1' "$CONFIG" >/dev/null
grep -F 'CF-Connecting-IP' "$CONFIG" >/dev/null
grep -F 'header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}' "$CONFIG" >/dev/null
grep -F 'header_up X-Forwarded-Proto https' "$CONFIG" >/dev/null
grep -F 'Cache-Control "no-store"' "$CONFIG" >/dev/null
grep -F 'Cache-Control "no-cache"' "$CONFIG" >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  echo "docker required for Caddy tunnel validate" >&2
  exit 1
fi

docker run --rm \
  -v "$ROOT/ops/caddy:/etc/caddy:ro" \
  caddy:2.9.1-alpine \
  caddy validate --config /etc/caddy/Caddyfile.tunnel.example --adapter caddyfile

echo "tunnel Caddyfile validate passed"
