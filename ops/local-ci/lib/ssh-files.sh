#!/usr/bin/env bash
# Shared pinned-host file validation; no credential material is printed.
ssh_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

ssh_file_owner() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

validate_known_hosts_line() {
  local line="$1" field1 field2 field3 rest
  case "$line" in ''|'#'*) return 0 ;; @*) line="${line#* }" ;; esac
  read -r field1 field2 field3 rest <<<"$line"
  [[ -n "$field1" && -n "$field2" && -n "$field3" && -z "$rest" ]] || return 1
  [[ "$field3" =~ ^[A-Za-z0-9+/=]+$ ]] || return 1
  case "$field2" in
    ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) return 0 ;;
    *) return 1 ;;
  esac
}

validate_known_hosts_file() {
  local file="$1" mode owner line has_entry=false
  [[ -f "$file" && ! -L "$file" ]] || return 1
  mode="$(ssh_file_mode "$file")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$mode & 0022) == 0 )) || return 1
  owner="$(ssh_file_owner "$file")" || return 1
  [[ "$owner" == "$EUID" || "$owner" == 0 ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    validate_known_hosts_line "$line" || return 1
    case "$line" in ''|'#'*) ;; *) has_entry=true ;; esac
  done <"$file"
  [[ "$has_entry" == true ]]
}
