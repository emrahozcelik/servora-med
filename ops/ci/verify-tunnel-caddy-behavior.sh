#!/usr/bin/env bash
# Request-level smoke for tunnel Caddy contracts (pinned Caddy image). Hard gate if docker missing.
# shellcheck disable=SC2317,SC2329
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$ROOT/ops/caddy/Caddyfile.tunnel.example"
PUBLIC_HOST="app.example.com"
CADDY_PORT=18080
BACKEND_PORT=13000

if ! command -v docker >/dev/null 2>&1; then
  echo "docker required for tunnel Caddy behavior smoke" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl required for tunnel Caddy behavior smoke" >&2
  exit 1
fi

test -f "$TEMPLATE"

# Contract preconditions from the real pilot template.
grep -F 'bind 127.0.0.1' "$TEMPLATE" >/dev/null
grep -F 'client_ip_headers CF-Connecting-IP' "$TEMPLATE" >/dev/null
grep -F 'trusted_proxies static 127.0.0.0/8 ::1' "$TEMPLATE" >/dev/null
grep -F 'header_up X-Forwarded-For {client_ip}' "$TEMPLATE" >/dev/null
grep -F 'header_up X-Forwarded-Proto https' "$TEMPLATE" >/dev/null
grep -F 'header_up X-Forwarded-Host {host}' "$TEMPLATE" >/dev/null
grep -F 'Cache-Control "no-store"' "$TEMPLATE" >/dev/null
grep -F 'Cache-Control "no-cache"' "$TEMPLATE" >/dev/null
grep -F 'immutable' "$TEMPLATE" >/dev/null
grep -F "http://${PUBLIC_HOST}:8080" "$TEMPLATE" >/dev/null

TMP="$(mktemp -d "${TMPDIR:-/tmp}/servora-caddy-smoke-XXXXXX")"
CADDY_CID=""
cleanup() {
  if [[ -n "${CADDY_CID}" ]]; then
    docker logs "$CADDY_CID" >"$TMP/caddy.docker.log" 2>&1 || true
    docker rm -f "$CADDY_CID" >/dev/null 2>&1 || true
  fi
  if [[ "${SMOKE_FAILED:-0}" -eq 1 && -f "$TMP/caddy.docker.log" ]]; then
    echo "---- caddy container logs ----" >&2
    cat "$TMP/caddy.docker.log" >&2 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() {
  echo "$*" >&2
  SMOKE_FAILED=1
  exit 1
}

mkdir -p "$TMP/web/dist/assets"
printf '%s\n' '<!doctype html><title>spa</title><h1>servora-spa</h1>' >"$TMP/web/dist/index.html"
printf '%s\n' 'console.log("asset")' >"$TMP/web/dist/assets/app.js"

# Single Caddy process: backend echo site + public Host site with the pilot contracts.
cat >"$TMP/Caddyfile" <<EOF
{
	auto_https off
	servers :${CADDY_PORT} {
		trusted_proxies static 127.0.0.0/8 ::1
		client_ip_headers CF-Connecting-IP
	}
}

:${BACKEND_PORT} {
	bind 127.0.0.1
	respond "xff={http.request.header.X-Forwarded-For};xfp={http.request.header.X-Forwarded-Proto};xfh={http.request.header.X-Forwarded-Host}" 200
}

http://${PUBLIC_HOST}:${CADDY_PORT} {
	bind 127.0.0.1

	handle /api/* {
		header Cache-Control "no-store"
		reverse_proxy 127.0.0.1:${BACKEND_PORT} {
			header_up X-Forwarded-For {client_ip}
			header_up X-Forwarded-Proto https
			header_up X-Forwarded-Host {host}
		}
	}

	handle /assets/* {
		root * ${TMP}/web/dist
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}

	handle {
		root * ${TMP}/web/dist
		header Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}
EOF

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

ready=0
for _ in $(seq 1 80); do
  if ! docker inspect -f '{{.State.Running}}' "$CADDY_CID" 2>/dev/null | grep -qx true; then
    fail "caddy container exited early"
  fi
  if curl -fsS -o /dev/null -H "Host: ${PUBLIC_HOST}" "http://127.0.0.1:${CADDY_PORT}/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
[[ "$ready" -eq 1 ]] || fail "caddy did not become ready on 127.0.0.1:${CADDY_PORT}"

api_headers="$TMP/api.headers"
api_body="$(
  curl -fsS \
    -D "$api_headers" \
    -H "Host: ${PUBLIC_HOST}" \
    -H 'CF-Connecting-IP: 203.0.113.50' \
    "http://127.0.0.1:${CADDY_PORT}/api/health" \
    || fail "API request failed"
)"

echo "$api_body" | grep -Fq 'xff=203.0.113.50' || fail "missing visitor IP in X-Forwarded-For: ${api_body}"
echo "$api_body" | grep -Fq 'xfp=https' || fail "missing X-Forwarded-Proto=https: ${api_body}"
echo "$api_body" | grep -Fq "xfh=${PUBLIC_HOST}" || fail "missing X-Forwarded-Host: ${api_body}"
grep -iE '^Cache-Control:.*no-store' "$api_headers" >/dev/null || fail "API missing Cache-Control no-store"

spa_headers="$TMP/spa.headers"
spa_body="$(
  curl -fsS \
    -D "$spa_headers" \
    -H "Host: ${PUBLIC_HOST}" \
    "http://127.0.0.1:${CADDY_PORT}/" \
    || fail "SPA request failed"
)"
echo "$spa_body" | grep -Fq 'servora-spa' || fail "SPA body missing marker"
grep -iE '^Cache-Control:.*no-cache' "$spa_headers" >/dev/null || fail "SPA missing Cache-Control no-cache"

asset_headers="$TMP/asset.headers"
curl -fsS \
  -D "$asset_headers" \
  -o /dev/null \
  -H "Host: ${PUBLIC_HOST}" \
  "http://127.0.0.1:${CADDY_PORT}/assets/app.js" \
  || fail "asset request failed"
grep -iE '^Cache-Control:.*(immutable|max-age=31536000)' "$asset_headers" >/dev/null \
  || fail "assets missing immutable cache header"

wrong_code="$(
  curl -sS -o "$TMP/wrong.body" -w '%{http_code}' \
    -H 'Host: evil.example.com' \
    "http://127.0.0.1:${CADDY_PORT}/" || true
)"
if grep -Fq 'servora-spa' "$TMP/wrong.body" 2>/dev/null; then
  fail "wrong Host unexpectedly served Servora SPA body (http ${wrong_code})"
fi

echo "tunnel Caddy behavior smoke passed"
