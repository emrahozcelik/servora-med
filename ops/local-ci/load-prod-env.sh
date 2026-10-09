#!/usr/bin/env bash
# load-prod-env.sh — load production deploy credentials from a protected local file.
#
# Local credential format (documented, key-file based):
#   SERVORA_PROD_HOST=<hostname>
#   SERVORA_PROD_SSH_USER=<restricted account, never root>
#   SERVORA_PROD_SSH_KEY_FILE=<absolute path to a 0600/0400 OpenSSH key file>
#   SERVORA_PROD_KNOWN_HOSTS=<single pinned known_hosts line>
#     or SERVORA_PROD_KNOWN_HOSTS_FILE=<absolute path to a known_hosts file>
#   SERVORA_PROD_FQDN=<fqdn>
#
# A multiline private key MUST NOT be embedded in this file: the line-based
# parser cannot represent embedded newlines, so truncation would be silent.
# SERVORA_PROD_SSH_KEY inline values are refused here (use _FILE). The GitHub
# workflow path is unaffected: it receives multiline secrets via environment.
# Values are exported, never printed; the file itself must be 0600, not a
# symlink, and no value is ever executed as shell.
#
# Usage: eval "$(ops/local-ci/load-prod-env.sh [--file PATH])"
# Or: ops/local-ci/load-prod-env.sh --check [--file PATH]
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/ssh-files.sh
source "$SCRIPT_DIR/lib/ssh-files.sh"

ENV_FILE="${HOME:-/tmp}/.config/servora-med/prod.env"
CHECK_ONLY=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --file) ENV_FILE="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=true; shift ;;
    *) echo "CRED_LOAD_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done

# Portable permission read: GNU stat first, BSD stat fallback (the reverse
# order silently misfires — Linux `stat -f` reports filesystem status and
# exits 0 instead of failing).
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

[[ -n "$ENV_FILE" && -e "$ENV_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_MISSING" >&2; exit 1; }
[[ ! -L "$ENV_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_SYMLINK" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_NOT_REGULAR" >&2; exit 1; }
mode="$(file_mode "$ENV_FILE")"
[[ "$mode" == "600" ]] || { echo "CRED_LOAD_FAILED reason=CRED_FILE_PERMISSIONS_${mode}" >&2; exit 1; }

# Parse KEY=value lines only; anything else (including shell code) is inert.
# Values must be single-line printable text: embedded newlines are impossible
# in this format and control characters are refused outright.
get_value() {
  awk -F= -v k="$1" '$1 == k {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE"
}

HOST="$(get_value SERVORA_PROD_HOST)"
SSH_USER="$(get_value SERVORA_PROD_SSH_USER)"
KEY_FILE="$(get_value SERVORA_PROD_SSH_KEY_FILE)"
INLINE_KEY="$(get_value SERVORA_PROD_SSH_KEY)"
KNOWN_HOSTS="$(get_value SERVORA_PROD_KNOWN_HOSTS)"
KNOWN_HOSTS_FILE="$(get_value SERVORA_PROD_KNOWN_HOSTS_FILE)"
FQDN="$(get_value SERVORA_PROD_FQDN)"

[[ -z "$INLINE_KEY" ]] || { echo "CRED_LOAD_FAILED reason=CRED_INLINE_KEY_FORBIDDEN (use SERVORA_PROD_SSH_KEY_FILE)" >&2; exit 1; }
[[ -n "$HOST" && -n "$KEY_FILE" && -n "$FQDN" ]] \
  || { echo "CRED_LOAD_FAILED reason=CRED_KEYS_MISSING" >&2; exit 1; }
[[ -n "$KNOWN_HOSTS" || -n "$KNOWN_HOSTS_FILE" ]] \
  || { echo "CRED_LOAD_FAILED reason=CRED_KNOWN_HOSTS_MISSING" >&2; exit 1; }
[[ "$SSH_USER" != root ]] || { echo "CRED_LOAD_FAILED reason=CRED_ROOT_SSH_USER_FORBIDDEN" >&2; exit 1; }
if [[ -n "$SSH_USER" ]]; then
  [[ "$SSH_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || { echo "CRED_LOAD_FAILED reason=CRED_SSH_USER_INVALID" >&2; exit 1; }
fi
[[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "CRED_LOAD_FAILED reason=CRED_HOST_INVALID" >&2; exit 1; }

# Key-file validation: regular file, no symlink substitution, restricted
# permissions, bounded size, OpenSSH/PEM private-key header.
[[ -e "$KEY_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_KEY_FILE_MISSING" >&2; exit 1; }
[[ ! -L "$KEY_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_KEY_FILE_SYMLINK" >&2; exit 1; }
[[ -f "$KEY_FILE" ]] || { echo "CRED_LOAD_FAILED reason=CRED_KEY_FILE_NOT_REGULAR" >&2; exit 1; }
key_mode="$(file_mode "$KEY_FILE")"
[[ "$key_mode" == "600" || "$key_mode" == "400" ]] \
  || { echo "CRED_LOAD_FAILED reason=CRED_KEY_PERMISSIONS_${key_mode}" >&2; exit 1; }
key_size="$(wc -c <"$KEY_FILE" | tr -d ' ')"
[[ "$key_size" -gt 0 && "$key_size" -le 16384 ]] \
  || { echo "CRED_LOAD_FAILED reason=CRED_KEY_SIZE" >&2; exit 1; }
key_first_line="$(head -n 1 -- "$KEY_FILE" 2>/dev/null || head -n 1 "$KEY_FILE")"
[[ "$key_first_line" == "-----BEGIN OPENSSH PRIVATE KEY-----" || "$key_first_line" == "-----BEGIN RSA PRIVATE KEY-----" || "$key_first_line" == "-----BEGIN EC PRIVATE KEY-----" || "$key_first_line" == "-----BEGIN DSA PRIVATE KEY-----" ]] \
  || { echo "CRED_LOAD_FAILED reason=CRED_KEY_FORMAT" >&2; exit 1; }

if [[ -n "$KNOWN_HOSTS_FILE" ]]; then
  validate_known_hosts_file "$KNOWN_HOSTS_FILE" || { echo "CRED_LOAD_FAILED reason=CRED_KNOWN_HOSTS_FILE_INVALID" >&2; exit 1; }
else
  while IFS= read -r line || [[ -n "$line" ]]; do
    validate_known_hosts_line "$line" || { echo "CRED_LOAD_FAILED reason=CRED_KNOWN_HOSTS_FORMAT" >&2; exit 1; }
  done <<<"$KNOWN_HOSTS"
fi

if [[ "$CHECK_ONLY" == true ]]; then
  echo "CRED_CHECK_PASS file=${ENV_FILE}"
  exit 0
fi

# Emit export statements without ever printing key material: only paths and
# non-secret values pass through here.
printf 'unset SERVORA_PROD_HOST SERVORA_PROD_SSH_USER SERVORA_PROD_SSH_KEY SERVORA_PROD_SSH_KEY_FILE SERVORA_PROD_KNOWN_HOSTS SERVORA_PROD_KNOWN_HOSTS_FILE SERVORA_PROD_FQDN\n'
printf 'export SERVORA_PROD_HOST=%q\n' "$HOST"
[[ -z "$SSH_USER" ]] || printf 'export SERVORA_PROD_SSH_USER=%q\n' "$SSH_USER"
printf 'export SERVORA_PROD_SSH_KEY_FILE=%q\n' "$KEY_FILE"
if [[ -n "$KNOWN_HOSTS_FILE" ]]; then
  printf 'export SERVORA_PROD_KNOWN_HOSTS_FILE=%q\n' "$KNOWN_HOSTS_FILE"
else
  printf 'export SERVORA_PROD_KNOWN_HOSTS=%q\n' "$KNOWN_HOSTS"
fi
printf 'export SERVORA_PROD_FQDN=%q\n' "$FQDN"
