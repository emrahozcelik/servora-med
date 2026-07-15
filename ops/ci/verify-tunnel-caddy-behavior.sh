#!/usr/bin/env bash
# Request-level smoke for tunnel Caddyfile (pinned Caddy image). Hard gate when docker missing.
# shellcheck disable=SC2317,SC2329
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$ROOT/ops/caddy/Caddyfile.tunnel.example"
PUBLIC_HOST="app.example.com"
BACKEND_PORT=13000
CADDY_PORT=8080

if ! command -v docker >/dev/null 2>&1; then
  echo "docker required for tunnel Caddy behavior smoke" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node required for tunnel Caddy behavior smoke backend" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl required for tunnel Caddy behavior smoke" >&2
  exit 1
fi

test -f "$TEMPLATE"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/servora-caddy-smoke-XXXXXX")"
cleanup() {
  if [[ -n "${CADDY_CID:-}" ]]; then
    docker rm -f "$CADDY_CID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/web/dist/assets"
printf '%s\n' '<!doctype html><title>spa</title><h1>servora-spa</h1>' >"$TMP/web/dist/index.html"
printf '%s\n' 'console.log("asset")' >"$TMP/web/dist/assets/app.js"
: >"$TMP/access.log"

cat >"$TMP/backend.mjs" <<'EOF'
import http from 'node:http';

const port = Number(process.env.BACKEND_PORT || 13000);
http
  .createServer((req, res) => {
    const body = JSON.stringify({
      url: req.url,
      xff: req.headers['x-forwarded-for'] ?? null,
      xfp: req.headers['x-forwarded-proto'] ?? null,
      xfh: req.headers['x-forwarded-host'] ?? null,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write(`backend-ready:${port}\n`);
  });
EOF

BACKEND_PORT="$BACKEND_PORT" node "$TMP/backend.mjs" >"$TMP/backend.log" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 50); do
  if grep -q "backend-ready:${BACKEND_PORT}" "$TMP/backend.log" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if ! grep -q "backend-ready:${BACKEND_PORT}" "$TMP/backend.log" 2>/dev/null; then
  echo "mock backend failed to start" >&2
  cat "$TMP/backend.log" >&2 || true
  exit 1
fi

# Rewrite template paths for disposable smoke roots / backend / log.
sed \
  -e "s|/opt/servora-med/current/web/dist|${TMP}/web/dist|g" \
  -e "s|127\\.0\\.0\\.1:3000|127.0.0.1:${BACKEND_PORT}|g" \
  -e "s|/usr/local/var/log/servora-med/caddy-access.log|${TMP}/access.log|g" \
  "$TEMPLATE" >"$TMP/Caddyfile"

# Validate rewritten config first.
docker run --rm \
  -v "$TMP:/cfg:ro" \
  caddy:2.9.1-alpine \
  caddy validate --config /cfg/Caddyfile --adapter caddyfile >/dev/null

CADDY_CID="$(
  docker run -d --network host \
    -v "$TMP:$TMP" \
    caddy:2.9.1-alpine \
    caddy run --config "$TMP/Caddyfile" --adapter caddyfile
)"

for _ in $(seq 1 50); do
  if curl -fsS -o /dev/null -H "Host: ${PUBLIC_HOST}" "http://127.0.0.1:${CADDY_PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

api_headers="$(mktemp)"
api_body="$(
  curl -fsS \
    -D "$api_headers" \
    -H "Host: ${PUBLIC_HOST}" \
    -H 'CF-Connecting-IP: 203.0.113.50' \
    "http://127.0.0.1:${CADDY_PORT}/api/health"
)"

echo "$api_body" | grep -F '"xff":"203.0.113.50"' >/dev/null
echo "$api_body" | grep -F '"xfp":"https"' >/dev/null
echo "$api_body" | grep -F "\"xfh\":\"${PUBLIC_HOST}\"" >/dev/null
grep -iE '^Cache-Control:.*no-store' "$api_headers" >/dev/null

spa_headers="$(mktemp)"
spa_body="$(
  curl -fsS \
    -D "$spa_headers" \
    -H "Host: ${PUBLIC_HOST}" \
    "http://127.0.0.1:${CADDY_PORT}/"
)"
echo "$spa_body" | grep -F 'servora-spa' >/dev/null
grep -iE '^Cache-Control:.*no-cache' "$spa_headers" >/dev/null

asset_headers="$(mktemp)"
curl -fsS \
  -D "$asset_headers" \
  -o /dev/null \
  -H "Host: ${PUBLIC_HOST}" \
  "http://127.0.0.1:${CADDY_PORT}/assets/app.js"
grep -iE '^Cache-Control:.*(immutable|max-age=31536000)' "$asset_headers" >/dev/null

# Wrong Host must not be served as the Servora SPA site.
wrong_code="$(
  curl -sS -o "$TMP/wrong.body" -w '%{http_code}' \
    -H 'Host: evil.example.com' \
    "http://127.0.0.1:${CADDY_PORT}/" || true
)"
if grep -Fq 'servora-spa' "$TMP/wrong.body" 2>/dev/null; then
  echo "wrong Host unexpectedly served Servora SPA body (http ${wrong_code})" >&2
  exit 1
fi

echo "tunnel Caddy behavior smoke passed"
