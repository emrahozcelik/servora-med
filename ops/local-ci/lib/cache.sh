#!/usr/bin/env bash
# Persistent download caches are separate from run-owned database resources.
set -Eeuo pipefail

ci_prepare_web_image() {
  local guest_daemon started images
  started="$(date +%s)"
  WEB_IMAGE_KEY="$(node "$SCRIPT_DIR/cache-key.mjs" web-image "$EXPORT_DIR" "$WEB_PLATFORM")" || return 1
  local tag="servora-med/local-ci-web:${WEB_ARCH}-${WEB_IMAGE_KEY}"
  if ! WEB_IMAGE_ID="$(ci_docker image inspect --format '{{.Id}}' "$tag" 2>/dev/null)"; then
    # An inspection failure must not overwrite an existing, ambiguous image.
    images="$(ci_docker image ls -q --filter "reference=$tag")" || return 1
    [[ -z "$images" ]] || return 1
    echo "LOCAL_CI_BROWSER_IMAGE_MISS tag=$tag"
    ci_assert_docker_daemon || return 1
    guest_daemon="$(colima ssh --profile true -- docker --host unix:///var/run/docker.sock info --format '{{.ID}}')" || return 1
    [[ "$guest_daemon" == "$LOCAL_CI_DOCKER_DAEMON_ID" ]] || { echo 'LOCAL_CI_CACHE_FAILED reason=GUEST_DAEMON_MISMATCH' >&2; return 1; }
    # The guest supplies its existing Buildx. No host plugin/config changes.
    # Send only exact-export image inputs, never an operator's working tree.
    tar -C "$EXPORT_DIR" -c web/package.json web/package-lock.json ops/local-ci/images/web.Dockerfile ops/local-ci/browser-availability.mjs \
      | colima ssh --profile true -- docker --host unix:///var/run/docker.sock build --provenance=false --load \
        --platform "$WEB_PLATFORM" --build-arg "LOCAL_CI_IMAGE_KEY=$WEB_IMAGE_KEY" \
        --label "com.servora.local-ci.cache=web-image" --label "com.servora.local-ci.cache-key=$WEB_IMAGE_KEY" \
        -t "$tag" -f ops/local-ci/images/web.Dockerfile - || return 1
    WEB_IMAGE_ID="$(ci_docker image inspect --format '{{.Id}}' "$tag")" || return 1
  else
    echo "LOCAL_CI_BROWSER_IMAGE_HIT tag=$tag"
  fi
  [[ "$WEB_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  # Pin the immutable ID for execution and verify its key and actual runtime.
  ci_docker run --rm --platform "$WEB_PLATFORM" "$WEB_IMAGE_ID" node -e '
    const m = require("/opt/servora-playwright/image.json");
    if (m.imageKey !== process.argv[1] || m.installed.arch !== process.argv[2] || m.installed.node !== process.version || process.platform !== "linux") process.exit(1);
    console.log(JSON.stringify(m));
  ' "$WEB_IMAGE_KEY" "$WEB_ARCH" || return 1
  echo "LOCAL_CI_BROWSER_IMAGE_READY id=$WEB_IMAGE_ID platform=$WEB_PLATFORM seconds=$(($(date +%s) - started))"
}

ci_prepare_npm_volume() {
  local scope="$1" platform="$2" image="$3" uid="$4" runtime key name metadata
  runtime="$(ci_docker run --rm --platform "$platform" "$image" node -p 'JSON.stringify({node:process.version,npm:require("node:child_process").execSync("npm --version").toString().trim(),platform:process.platform,arch:process.arch})')" || return 1
  key="$(node "$SCRIPT_DIR/cache-key.mjs" "$scope" "$EXPORT_DIR" "$platform" "$runtime")" || return 1
  name="servora-localci-npm-${scope}-${key}"
  ci_assert_docker_daemon || return 1
  ci_docker volume create --driver local --label "com.servora.local-ci.cache=${scope}-npm" \
    --label "com.servora.local-ci.cache-key=$key" "$name" >/dev/null || return 1
  metadata="$(ci_docker volume inspect --format '{{.Driver}} {{index .Labels "com.servora.local-ci.cache"}} {{index .Labels "com.servora.local-ci.cache-key"}}' "$name")" || return 1
  [[ "$metadata" == "local ${scope}-npm $key" ]] || { echo 'LOCAL_CI_CACHE_FAILED reason=VOLUME_OWNERSHIP_MISMATCH' >&2; return 1; }
  # Fixed separate scopes: server writes as node (1000); web writes as root.
  # Only the mount root is changed, after proving this cache's ownership.
  ci_docker run --rm --platform "$platform" --user 0 \
    --mount "type=volume,source=$name,target=/npm-cache" "$image" chown "$uid:$uid" /npm-cache || return 1
  echo "LOCAL_CI_NPM_CACHE scope=$scope platform=$platform volume=$name runtime=$runtime" >&2
  printf '%s' "$name"
}

ci_prepare_caches() {
  local arch
  arch="$(ci_docker info --format '{{.Architecture}}')" || return 1
  case "$arch" in
    aarch64|arm64) WEB_ARCH=arm64 ;;
    x86_64|amd64) WEB_ARCH=x64 ;;
    *) echo 'LOCAL_CI_CACHE_FAILED reason=UNSUPPORTED_DAEMON_ARCH' >&2; return 1 ;;
  esac
  WEB_PLATFORM=linux/arm64
  [[ "$WEB_ARCH" != x64 ]] || WEB_PLATFORM=linux/amd64
  ci_prepare_web_image || return 1
  # shellcheck disable=SC2034 # Cache names consumed by run.sh.
  SERVER_NPM_CACHE="$(ci_prepare_npm_volume server linux/amd64 node:22-bookworm 1000)" || return 1
  # shellcheck disable=SC2034 # Cache names consumed by run.sh.
  WEB_NPM_CACHE="$(ci_prepare_npm_volume web "$WEB_PLATFORM" "$WEB_IMAGE_ID" 0)" || return 1
}
