#!/usr/bin/env bash
# load-prod-env.sh — load production deploy credentials from a protected local file.
#
# The GitHub workflow supplies SERVORA_PROD_* via environment secrets. Locally,
# the operator provisions them once in a 0600 file (default
# ~/.config/servora-med/prod.env) with `KEY=value` lines. This loader refuses:
# missing file, group/other-readable file, symlink, missing required keys.
# Values are exported, never printed.
#
# Usage: eval "$(ops/local-ci/load-prod-env.sh [--file PATH])"
# Or: ops/local-ci/load-prod-env.sh --check [--file PATH]
set -Eeuo pipefail

ENV_FILE="${HOME:-/tmp}/.config/servora-med/prod.env"
CHECK_ONLY=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --file) ENV_FILE="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=true; shift ;;
    *) echo "CRED_LOAD_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done

[[ -n "$ENV_FILE" && -e "$ENV_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_MISSING" >&2; exit 1; }
[[ ! -L "$ENV_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_SYMLINK" >&2; exit 1; }
mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")"
[[ "$mode" == "600" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_PERMISSIONS_${mode}" >&2; exit 1; }

required=(SERVORA_PROD_HOST SERVORA_PROD_SSH_KEY SERVORA_PROD_KNOWN_HOSTS SERVORA_PROD_FQDN)
if [[ "$CHECK_ONLY" == true ]]; then
  missing=()
  for key in "${required[@]}"; do
    val="$(awk -F= -v k="$key" '$1 == k {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")"
    [[ -n "$val" ]] || missing+=("$key")
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "CRED_LOAD_FAILED reason=CRED_KEYS_MISSING_${missing[*]}" >&2
    exit 1
  fi
  echo "CRED_CHECK_PASS file=${ENV_FILE}"
  exit 0
fi

# Emit export statements without ever printing values to the terminal here;
# the caller evals them into its own environment.
while IFS= read -r line; do
  [[ "$line" =~ ^SERVORA_PROD_[A-Z_]+= ]] || continue
  key="${line%%=*}"
  printf 'export %s=%q\n' "$key" "${line#*=}"
done <"$ENV_FILE"
