#!/usr/bin/env bash
# Shared evidence-bundle helpers for local-first CI and local deploy gates.
#
# An evidence bundle is a directory:
#   <evidence-root>/<sha>/
#     manifest.json   machine-readable result + per-check log hashes
#     report.md       human-readable summary
#     logs/           one log file per check (referenced by manifest)
#
# Trust model (explicit; no PKI, no trusted execution environment):
#   1. Exact Git source identity — the verifier binds the bundle to one exact
#      commit SHA and tree; the deploy gate re-resolves both from the live
#      repository and origin/main, so evidence for any other source is useless.
#   2. Evidence file integrity — every log hash is recomputed; tampering with
#      any byte after assembly is detected. The manifest alone never
#      authorizes deployment.
#   3. Execution provenance — NOT cryptographically established. SHA-256 of a
#      log proves integrity relative to its manifest, not that the log came
#      from a real execution. A self-consistent bundle only proves internal
#      consistency; it MUST be described as "local-operator-attested", never
#      as independently authenticated. The verifier refuses any other
#      provenance claim. Reproducibility is the backstop: anyone can re-run
#      run.sh on the same SHA and must obtain the same per-check outcomes.
#   4. Operator approval — the human operator explicitly invoking the deploy
#      on a machine they control; local evidence is valid only for its exact
#      SHA/tree and is re-verified at deploy time.
#   5. Deployment authorization — possession of the production SSH private
#      key plus pinned known_hosts identity. This secret is independent of
#      the evidence bundle: forging evidence never yields authorization.
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
