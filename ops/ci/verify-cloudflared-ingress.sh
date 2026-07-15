#!/usr/bin/env bash
# Validate cloudflared ingress template with a pinned cloudflared image (hard gate).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$ROOT/ops/cloudflared/config.yml.example"
# Pin a known cloudflared release used for ingress validation only.
CLOUDFLARED_IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:2026.7.2}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker required for cloudflared ingress validation" >&2
  exit 1
fi

test -f "$TEMPLATE"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/servora-cloudflared-XXXXXX")"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

# Synthetic UUID + credentials path for validation only (never real secrets).
UUID="00000000-0000-4000-8000-000000000001"
printf '%s\n' \
  "{\"AccountTag\":\"ci-validate\",\"TunnelSecret\":\"dGVzdC1zZWNyZXQ=\",\"TunnelID\":\"${UUID}\"}" \
  >"${TMP}/${UUID}.json"

# Drop comment-only lines and map credentials path to the container mount (/config).
grep -v '^[[:space:]]*#' "$TEMPLATE" \
  | sed \
    -e "s/<TUNNEL_UUID>/${UUID}/g" \
    -e "s|/etc/cloudflared|/config|g" \
  >"${TMP}/config.yml"

# cloudflared image runs as non-root; ensure mounted files are world-readable.
chmod 0644 "${TMP}/config.yml" "${TMP}/${UUID}.json"
chmod 0755 "${TMP}"

# Ensure required origin Host alignment is present after substitution.
grep -F 'hostname: app.example.com' "${TMP}/config.yml" >/dev/null
grep -F 'httpHostHeader: app.example.com' "${TMP}/config.yml" >/dev/null
grep -F 'service: http_status:404' "${TMP}/config.yml" >/dev/null
grep -F "credentials-file: /config/${UUID}.json" "${TMP}/config.yml" >/dev/null

docker run --rm \
  -v "${TMP}:/config:ro" \
  "${CLOUDFLARED_IMAGE}" \
  tunnel --config /config/config.yml ingress validate

docker run --rm \
  -v "${TMP}:/config:ro" \
  "${CLOUDFLARED_IMAGE}" \
  tunnel --config /config/config.yml ingress rule https://app.example.com

echo "cloudflared ingress validate/rule passed"
