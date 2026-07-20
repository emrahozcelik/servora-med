#!/usr/bin/env bash
# Docker Caddy end-to-end SSE streaming behavior smoke test.
# Verifies real proxy preserves text/event-stream, flushes first event,
# forwards heartbeat, and keeps connection open.
set -Eeuo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker required for SSE streaming behavior smoke" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl required for SSE streaming behavior smoke" >&2
  exit 1
fi

BACKEND_PORT=14000
CADDY_PORT=14080

TMP="$(mktemp -d "${TMPDIR:-/tmp}/servora-sse-smoke-XXXXXX")"
BACKEND_PID=""
CADDY_CID=""
SMOKE_FAILED=0

cleanup() {
  if [[ -n "${BACKEND_PID}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "${CADDY_CID}" ]]; then
    docker logs "$CADDY_CID" >"$TMP/caddy.docker.log" 2>&1 || true
    docker rm -f "$CADDY_CID" >/dev/null 2>&1 || true
  fi
  if [[ "${SMOKE_FAILED}" -eq 1 && -f "$TMP/caddy.docker.log" ]]; then
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

# --- Fake SSE backend ---
cat >"$TMP/sse-server.mjs" <<'NODESERVER'
import http from 'node:http';

const PORT = parseInt(process.env.BACKEND_PORT || '14000', 10);

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let counter = 0;
  const sendEvent = () => {
    counter++;
    const event = `id: ${counter}\nevent: servora.change\ndata: ${JSON.stringify({ id: String(counter), type: 'job.started', entity: { type: 'job-card', id: 'job-1' }, resourceKeys: ['job-board'], occurredAt: new Date().toISOString() })}\n\n`;
    res.write(event);
  };

  sendEvent();

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 2000);
  heartbeat.unref();

  req.once('close', () => {
    clearInterval(heartbeat);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`listening on 127.0.0.1:${PORT}\n`);
});
NODESERVER

chmod +x "$TMP/sse-server.mjs"

# --- Generate disposable Caddyfile ---
cat >"$TMP/Caddyfile" <<CADDY
{
	auto_https off
}

http://127.0.0.1:${CADDY_PORT} {
	bind 127.0.0.1

	handle /events {
		reverse_proxy 127.0.0.1:${BACKEND_PORT}
	}
}
CADDY

# --- Validate Caddyfile ---
docker run --rm \
  -v "$TMP:/cfg:ro" \
  caddy:2.9.1-alpine \
  caddy validate --config /cfg/Caddyfile --adapter caddyfile >/dev/null

# --- Start backend SSE server ---
node "$TMP/sse-server.mjs" &
BACKEND_PID=$!

# --- Start Docker Caddy ---
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
  if curl -fsS -o /dev/null "http://127.0.0.1:${CADDY_PORT}/" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
[[ "$ready" -eq 1 ]] || fail "caddy did not become ready on 127.0.0.1:${CADDY_PORT}"

# --- Ensure backend is ready ---
sleep 1

# --- Test SSE streaming behavior ---
# Use one deliberately time-bounded request: curl exit 28 proves that the
# proxy kept the SSE connection open while the captured body proves flushing.
set +e
curl --silent --show-error --no-buffer --max-time 5 \
  --dump-header "$TMP/headers" \
  "http://127.0.0.1:${CADDY_PORT}/events" \
  >"$TMP/body"
curl_status=$?
set -e

[[ "$curl_status" -eq 28 ]] \
  || fail "SSE connection did not remain open for the test interval (curl: $curl_status)"

if grep -qi '^content-type: text/event-stream' "$TMP/headers"; then
  echo "SSE Content-Type verified"
else
  fail "expected text/event-stream response"
fi

if grep -q 'event: servora.change' "$TMP/body"; then
  echo "SSE event received through Caddy proxy"
else
  fail "no servora.change event received through Caddy proxy"
fi

if grep -q ': heartbeat' "$TMP/body"; then
  echo "SSE heartbeat received through Caddy proxy"
else
  fail "no heartbeat received through Caddy proxy"
fi

echo "SSE streaming behavior smoke passed"
