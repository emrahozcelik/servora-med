#!/usr/bin/env bash
# Validate Caddyfile with a pinned Caddy container (hard gate).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$ROOT/ops/caddy/Caddyfile.example"

if ! grep -F 'Cache-Control "no-store"' "$CONFIG" >/dev/null; then
  echo "Caddyfile missing API Cache-Control no-store" >&2
  exit 1
fi
if ! grep -F 'Cache-Control "no-cache"' "$CONFIG" >/dev/null; then
  echo "Caddyfile missing SPA/app-shell Cache-Control no-cache" >&2
  exit 1
fi
if ! grep -F 'path /assets/*' "$CONFIG" >/dev/null && ! grep -F 'handle /assets/*' "$CONFIG" >/dev/null; then
  echo "Caddyfile missing /assets/* immutable handler" >&2
  exit 1
fi

if ! grep -F 'handle /service-worker.js' "$CONFIG" >/dev/null; then
  echo "Caddyfile missing /service-worker.js dedicated handler" >&2
  exit 1
fi

grep -A5 'handle /service-worker.js' "$CONFIG" | grep -Fq 'Cache-Control "no-cache"' || {
  echo "Caddyfile /service-worker.js handler missing no-cache" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to validate Caddyfile with pinned caddy image" >&2
  exit 1
fi

docker run --rm \
  -v "$ROOT/ops/caddy:/etc/caddy:ro" \
  caddy:2.9.1-alpine \
  caddy validate --config /etc/caddy/Caddyfile.example --adapter caddyfile

echo "caddy validate passed"
"$ROOT/ops/ci/verify-sse-streaming.sh" "$CONFIG"
