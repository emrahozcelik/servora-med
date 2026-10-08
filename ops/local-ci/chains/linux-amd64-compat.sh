#!/usr/bin/env bash
# linux-amd64-compat.sh — prove the production dependency tree installs and
# imports on linux/amd64, so a lockfile-built artifact is safe for the x86_64
# production VPS regardless of the builder OS/arch.
#
# Runs on the operator host (needs the docker CLI): pulls no new images
# (reuses node:22-bookworm, already required) and executes the prod install +
# import inside a --platform linux/amd64 container (Rosetta-emulated on
# ARM Colima hosts; native on x86_64 hosts).
#
# Usage: ops/local-ci/chains/linux-amd64-compat.sh --server-dir <dir>
# Exit 0 prints a JSON detail object consumed by the evidence manifest:
#   { platform, emulated, productionPackages, result }
# Any failure fails closed (emulation unavailable, install failure, import
# failure, unexpected container arch).
set -Eeuo pipefail

SERVER_DIR=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --server-dir) SERVER_DIR="${2:-}"; shift 2 ;;
    *) echo "LINUX_AMD64_COMPAT_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done

[[ -n "$SERVER_DIR" && -f "$SERVER_DIR/package.json" && -f "$SERVER_DIR/package-lock.json" ]] \
  || { echo "LINUX_AMD64_COMPAT_FAILED reason=SERVER_DIR_INVALID" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "LINUX_AMD64_COMPAT_FAILED reason=DOCKER_MISSING" >&2; exit 1; }

CONTAINER_ARCH="$(docker run --rm --platform linux/amd64 node:22-bookworm uname -m 2>/dev/null)" \
  || { echo "LINUX_AMD64_COMPAT_FAILED reason=LINUX_AMD64_UNAVAILABLE (linux/amd64 emulation required: Colima vz + Rosetta, or an x86_64 host)" >&2; exit 1; }
[[ "$CONTAINER_ARCH" == "x86_64" ]] || { echo "LINUX_AMD64_COMPAT_FAILED reason=UNEXPECTED_CONTAINER_ARCH_${CONTAINER_ARCH}" >&2; exit 1; }

HOST_ARCH="$(uname -m)"
EMULATED="false"
[[ "$HOST_ARCH" == "x86_64" || "$HOST_ARCH" == "amd64" ]] || EMULATED="true"

IMPORT_JSON="$(docker run --rm --platform linux/amd64 -v "$SERVER_DIR:/src:ro" node:22-bookworm bash -c '
set -e
cp -a /src /build && cd /build
npm ci --omit=dev --no-audit --no-fund >/dev/null
node --input-type=module -e "
import fs from \"node:fs\";
const deps = Object.keys(JSON.parse(fs.readFileSync(\"package.json\", \"utf8\")).dependencies ?? {});
for (const d of deps) { await import(d); }
console.log(JSON.stringify({ imported: deps.length }));
"
npm ls --omit=dev --parseable 2>/dev/null | wc -l
' 2>/dev/null)" || { echo "LINUX_AMD64_COMPAT_FAILED reason=AMD64_INSTALL_OR_IMPORT_FAILED" >&2; exit 1; }

IMPORT_LINE="$(printf '%s' "$IMPORT_JSON" | grep '^{' | tail -n 1)"
IMPORTED="$(printf '%s' "$IMPORT_LINE" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).imported" 2>/dev/null || echo invalid)"
TOTAL="$(printf '%s' "$IMPORT_JSON" | sed -n '2p' | tr -d ' ')"
[[ "$IMPORTED" =~ ^[0-9]+$ && "$IMPORTED" -gt 0 ]] \
  || { echo "LINUX_AMD64_COMPAT_FAILED reason=AMD64_IMPORT_COUNT_INVALID" >&2; exit 1; }
[[ "$TOTAL" =~ ^[0-9]+$ && "$TOTAL" -ge "$IMPORTED" ]] \
  || { echo "LINUX_AMD64_COMPAT_FAILED reason=AMD64_PACKAGE_COUNT_INVALID" >&2; exit 1; }

printf '{"platform":"linux/amd64","emulated":%s,"productionPackages":%s,"importedDirect":%s,"result":"pass"}\n' "$EMULATED" "$TOTAL" "$IMPORTED"
echo "linux/amd64 production install+import: ${TOTAL} packages installed, ${IMPORTED} direct imports OK (emulated=${EMULATED})" >&2
