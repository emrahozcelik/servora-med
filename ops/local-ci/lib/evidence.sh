#!/usr/bin/env bash
# Shared evidence-bundle helpers for local-first CI and local deploy gates.
#
# An evidence bundle is a directory:
#   <evidence-root>/<sha>/
#     manifest.json   machine-readable result + per-check log hashes
#     report.md       human-readable summary
#     logs/           one log file per check (referenced by manifest)
#     logs/aux/cleanup.{log,status}  hash-bound independent cleanup result
#
# Schema 2 keeps the same 27 test gates. The assembler's initial manifest is
# provisional: under the CI lock, EXIT cleanup binds result/mode and hashes of
# the two fixed cleanup files into manifest.cleanup. Acceptance requires both
# the 27-check result and cleanup PASS. Schema-1 evidence remains historical;
# it cannot satisfy this contract and must be rerun, never silently upgraded.
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

# shellcheck disable=SC2034 # Public constant consumed by verify-evidence.sh.
EVIDENCE_SCHEMA_VERSION=2

# Required check ids — read from the single source of truth
# ops/local-ci/required-checks.txt (one id per line; keep in sync with
# .github/workflows/ci.yml coverage). Portable while-read: no mapfile, so
# macOS bash 3.2 works.
REQUIRED_EVIDENCE_CHECKS=()
while IFS= read -r _check_id || [[ -n "$_check_id" ]]; do
  case "$_check_id" in ''|'#'*) continue ;; esac
  [[ "$_check_id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo EVIDENCE_POLICY_INVALID >&2; exit 1; }
  for _existing_id in ${REQUIRED_EVIDENCE_CHECKS[@]+"${REQUIRED_EVIDENCE_CHECKS[@]}"}; do
    [[ "$_check_id" != "$_existing_id" ]] || { echo EVIDENCE_POLICY_INVALID >&2; exit 1; }
  done
  REQUIRED_EVIDENCE_CHECKS+=("$_check_id")
done < "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)/required-checks.txt"

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

[[ "${#REQUIRED_EVIDENCE_CHECKS[@]}" -gt 0 ]] || { echo EVIDENCE_POLICY_INVALID >&2; exit 1; }
