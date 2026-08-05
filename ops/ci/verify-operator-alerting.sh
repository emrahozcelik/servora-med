#!/usr/bin/env bash
# Servora-Med operator alerting CI gate — syntax, tests and unit contracts.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

node --check "${ROOT}/ops/scripts/operator-alerting.mjs"
node --test "${ROOT}/ops/scripts/tests/operator-alerting.test.mjs"

bash -n \
  "${ROOT}/ops/launchd/run-alerting.sh.example" \
  "${ROOT}/ops/ci/verify-operator-alerting.sh"

# launchd plist: strict XML parse + scheduling contract + no credentials.
python3 - "${ROOT}/ops/launchd/com.servora-med.alerting.plist.example" << 'PYEOF'
import plistlib
import sys

with open(sys.argv[1], 'rb') as handle:
    plist = plistlib.load(handle)

assert plist['Label'] == 'com.servora-med.alerting'
assert plist['StartInterval'] == 300
assert plist.get('RunAtLoad', True) is False
assert '/usr/local/libexec/servora-med/run-alerting.sh' in plist['ProgramArguments']
assert 'servora-med' in (plist.get('UserName', ''), plist.get('GroupName', ''))
print('launchd plist contract OK')
PYEOF

# systemd units are verified by verify-systemd-units.sh (systemd-analyze).
echo "operator alerting CI gate passed"
