#!/usr/bin/env bash
# Shared evidence-bundle helpers for local-first CI and local deploy gates.
#
# An evidence bundle is a directory:
#   <evidence-root>/<sha>/
#     manifest.json   machine-readable result + per-check log hashes
#     report.md       human-readable summary
#     logs/           one log file per check (referenced by manifest)
#
# Integrity model (documented, no PKI): the verifier recomputes every log
# SHA-256 and re-checks SHA/tree/result/policy. The manifest alone never
# authorizes deployment: the deploy gate independently re-verifies origin/main
# SHA, tree identity and worktree cleanliness from the live repository.
# Evidence lives outside the source checkout; only hashes are summarized in PRs.
set -Eeuo pipefail

EVIDENCE_SCHEMA_VERSION=1

# Required check ids. Keep in sync with ops/local-ci/run.sh and
# .github/workflows/ci.yml coverage.
REQUIRED_EVIDENCE_CHECKS=(
  server-static-syntax
  server-shellcheck
  server-systemd-units
  server-backup-observation
  server-operator-alerting
  server-caddyfile
  server-sse-behavior
  server-tunnel-caddyfile
  server-tunnel-behavior
  server-cloudflared-ingress
  server-env-examples
  server-db-auth-contract
  server-build
  server-dep-smoke
  server-migrate-schema
  server-tests
  server-audit
  web-build
  web-bundle
  web-tests
  web-playwright-install
  web-smoke-dist
  web-smoke-responsive
  web-geometry
  web-audit
  benchmark-smoke
  linux-compat
)

evidence_sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

# evidence_manifest_path <evidence-root> <sha>
evidence_manifest_path() {
  printf '%s/%s/manifest.json' "$1" "$2"
}
