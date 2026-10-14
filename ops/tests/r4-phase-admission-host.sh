#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(hostname)" == lima-servora-r4-20261012 && "$EUID" -eq 0 ]]
helper=/usr/local/libexec/servora-med/deploy-production-host
before="$(sha256sum /etc/servora-med/servora-med.env)"
pointer="$(readlink /opt/servora-med/current)"
set +e
output="$(bash "$helper" --phase forward-recovery --attempt-id 99999999-9999-4999-8999-999999999999 2>&1)"
code=$?
set -e
printf 'FORWARD_ENTRY_EXIT=%s\n%s\n' "$code" "$output"
[[ "$code" -ne 0 && "$output" == *ATTEMPT_APPROVAL_MISSING* ]]
[[ "$before" == "$(sha256sum /etc/servora-med/servora-med.env)" ]]
[[ "$pointer" == "$(readlink /opt/servora-med/current)" ]]
echo FORWARD_PHASE_UNSEALED_ATTEMPT_REFUSED=PASS
