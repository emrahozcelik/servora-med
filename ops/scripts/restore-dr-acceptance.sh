#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Disposable acceptance only. This script never changes production service
# configuration. Real R2 execution is a separate, explicit mode which accepts
# only dedicated acceptance credentials; normal runtime R2 variables are not a
# fallback. The test owns only its random PostgreSQL databases, temporary age
# identity, temporary file roots, and one canonical object key.

usage() {
  printf '%s\n' \
    "Usage: $0 [--i-accept-real-r2-test] [--keep-target]" \
    "" \
    "No flag: deterministic local DR acceptance." \
    "--i-accept-real-r2-test: paid/persistent real Cloudflare R2 acceptance."
}

real_r2=false
keep_target=false
for argument in "$@"; do
  case "${argument}" in
    --i-accept-real-r2-test) real_r2=true ;;
    --keep-target) keep_target=true ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

export BR7_FULL_DR_ACCEPTANCE=1
export SERVORA_ACCEPTANCE_KEEP_TARGET=0
if [[ "${keep_target}" == true ]]; then
  export SERVORA_ACCEPTANCE_KEEP_TARGET=1
fi

if [[ "${real_r2}" == true ]]; then
  bucket_configured=NO
  credentials_configured=NO
  if [[ -n "${SERVORA_ACCEPTANCE_R2_BUCKET:-}" ]]; then
    bucket_configured=YES
  fi
  missing=false
  for name in \
    SERVORA_ACCEPTANCE_R2_ACCOUNT_ID \
    SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID \
    SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY; do
    if [[ -z "${!name:-}" ]]; then
      missing=true
    fi
  done
  if [[ "${missing}" == false ]]; then
    credentials_configured=YES
  fi
  if [[ "${bucket_configured}" == NO || "${missing}" == true ]]; then
    printf '%s\n' \
      "acceptance bucket configured? ${bucket_configured}" \
      "acceptance credentials configured? ${credentials_configured}" \
      "explicit opt-in supplied? YES" \
      "ephemeral age identity generated? NO" \
      "source DB synthetic? NO" \
      "acceptance instance ID production-distinct? NO" \
      "REAL_R2_DR_ACCEPTANCE = NOT EXECUTED" \
      "reason: dedicated disposable Cloudflare R2 acceptance credentials unavailable"
    exit 3
  fi

  # A configured production bucket or exact production credential pair must
  # never be silently reused for acceptance. Values are compared but never
  # printed.
  if [[ -n "${BACKUP_R2_BUCKET:-}" \
    && "${SERVORA_ACCEPTANCE_R2_BUCKET}" == "${BACKUP_R2_BUCKET}" ]]; then
    printf '%s\n' \
      "acceptance bucket configured? YES" \
      "acceptance credentials configured? YES" \
      "explicit opt-in supplied? YES" \
      "ephemeral age identity generated? NO" \
      "source DB synthetic? NO" \
      "acceptance instance ID production-distinct? NO" \
      "REAL_R2_DR_ACCEPTANCE = NOT EXECUTED" \
      "reason: acceptance bucket is not production-distinct"
    exit 3
  fi
  if [[ -n "${BACKUP_R2_ACCESS_KEY_ID:-}" \
    && -n "${BACKUP_R2_SECRET_ACCESS_KEY:-}" \
    && "${SERVORA_ACCEPTANCE_R2_ACCESS_KEY_ID}" == "${BACKUP_R2_ACCESS_KEY_ID}" \
    && "${SERVORA_ACCEPTANCE_R2_SECRET_ACCESS_KEY}" == "${BACKUP_R2_SECRET_ACCESS_KEY}" ]]; then
    printf '%s\n' \
      "acceptance bucket configured? YES" \
      "acceptance credentials configured? YES" \
      "explicit opt-in supplied? YES" \
      "ephemeral age identity generated? NO" \
      "source DB synthetic? NO" \
      "acceptance instance ID production-distinct? NO" \
      "REAL_R2_DR_ACCEPTANCE = NOT EXECUTED" \
      "reason: acceptance credentials are not production-distinct"
    exit 3
  fi

  script_dir="$(cd "$(dirname "$0")" && pwd -P)"
  repository_root="$(cd "${script_dir}/../.." && pwd -P)"
  export SERVORA_ACCEPTANCE_REAL_R2=1
  export SERVORA_ACCEPTANCE_REAL_R2_CONFIRM=explicit-operator-opt-in
  export SERVORA_ACCEPTANCE_EVIDENCE_DIR="${repository_root}/docs/evidence/backup-recovery-real-r2"
else
  export SERVORA_ACCEPTANCE_REAL_R2=0
  unset SERVORA_ACCEPTANCE_REAL_R2_CONFIRM
fi

if [[ "${real_r2}" == true ]]; then
  if [[ -z "${TEST_DATABASE_URL:-}" \
    || -z "${AGE_BIN:-}" \
    || -z "${AGE_KEYGEN_BIN:-}" ]]; then
    printf '%s\n' \
      "acceptance bucket configured? YES" \
      "acceptance credentials configured? YES" \
      "explicit opt-in supplied? YES" \
      "ephemeral age identity generated? NO" \
      "source DB synthetic? NO" \
      "acceptance instance ID production-distinct? NO" \
      "REAL_R2_DR_ACCEPTANCE = NOT EXECUTED" \
      "reason: disposable PostgreSQL or age acceptance prerequisites unavailable"
    exit 3
  fi
  if [[ -n "${DATABASE_URL:-}" && "${TEST_DATABASE_URL}" == "${DATABASE_URL}" ]] \
    || [[ -n "${PRODUCTION_DATABASE_URL:-}" \
      && "${TEST_DATABASE_URL}" == "${PRODUCTION_DATABASE_URL}" ]]; then
    printf '%s\n' \
      "acceptance bucket configured? YES" \
      "acceptance credentials configured? YES" \
      "explicit opt-in supplied? YES" \
      "ephemeral age identity generated? NO" \
      "source DB synthetic? NO" \
      "acceptance instance ID production-distinct? NO" \
      "REAL_R2_DR_ACCEPTANCE = NOT EXECUTED" \
      "reason: acceptance PostgreSQL control URL is not production-distinct"
    exit 3
  fi
  for binary in "${AGE_BIN}" "${AGE_KEYGEN_BIN}"; do
    if [[ "${binary}" == */* ]]; then
      available=$([[ -x "${binary}" ]] && printf YES || printf NO)
    else
      available=$(command -v -- "${binary}" >/dev/null 2>&1 && printf YES || printf NO)
    fi
    if [[ "${available}" == NO ]]; then
      printf '%s\n' \
        "acceptance bucket configured? YES" \
        "acceptance credentials configured? YES" \
        "explicit opt-in supplied? YES" \
        "ephemeral age identity generated? NO" \
        "source DB synthetic? NO" \
        "acceptance instance ID production-distinct? NO" \
        "REAL_R2_DR_ACCEPTANCE = NOT EXECUTED" \
        "reason: disposable PostgreSQL or age acceptance prerequisites unavailable"
      exit 3
    fi
  done
else
  : "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
  : "${AGE_BIN:?AGE_BIN must point to official age >= 1.3.0}"
  : "${AGE_KEYGEN_BIN:?AGE_KEYGEN_BIN must point to official age-keygen}"
fi

cd "$(dirname "$0")/../../server"
if npm run build \
  && npm test -- --run tests/backup-dr-full-acceptance.test.ts; then
  if [[ "${real_r2}" == true ]]; then
    printf '%s\n' "REAL_R2_DR_ACCEPTANCE = PASS"
  fi
else
  status=$?
  if [[ "${real_r2}" == true ]]; then
    printf '%s\n' "REAL_R2_DR_ACCEPTANCE = FAIL"
  fi
  exit "${status}"
fi
