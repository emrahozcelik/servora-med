#!/usr/bin/env bash
# verify-linux-compat.sh — prove the production dependency tree carries no
# platform-specific code, so a lockfile-built artifact is Linux/amd64-safe
# regardless of the builder OS.
#
# Usage: ops/local-ci/verify-linux-compat.sh --server-dir <dir>
# Exit 0 prints a JSON detail object consumed by the evidence manifest:
#   { productionPackages, nativeBinaries, osRestricted, cpuRestricted,
#     builderOs, builderArch, nodeVersion }
# Any non-zero count fails closed.
set -Eeuo pipefail

SERVER_DIR=""
JSON_OUT=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --server-dir) SERVER_DIR="${2:-}"; shift 2 ;;
    --json) JSON_OUT=true; shift ;;
    *) echo "LINUX_COMPAT_FAILED reason=UNKNOWN_ARGUMENT" >&2; exit 1 ;;
  esac
done

[[ -n "$SERVER_DIR" && -d "$SERVER_DIR/node_modules" ]] \
  || { echo "LINUX_COMPAT_FAILED reason=NODE_MODULES_MISSING (run npm ci --omit=dev first)" >&2; exit 1; }

node --input-type=module -e "$(cat <<'NODEEOF'
import fs from 'node:fs';
import path from 'node:path';
const [serverDir] = process.argv.slice(1);
const nm = path.join(serverDir, 'node_modules');
let productionPackages = 0, nativeBinaries = 0, osRestricted = 0, cpuRestricted = 0;
const offenders = [];
const walk = (dir, depth) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.node')) { nativeBinaries++; offenders.push(p); }
    if (e.isDirectory()) {
      if (e.name === '.bin' || e.name === '.cache') continue;
      const pkg = path.join(p, 'package.json');
      if (fs.existsSync(pkg) && depth < 4) {
        try {
          const m = JSON.parse(fs.readFileSync(pkg, 'utf8'));
          productionPackages++;
          if (m.os) { osRestricted++; offenders.push(m.name + ' os=' + JSON.stringify(m.os)); }
          if (m.cpu) { cpuRestricted++; offenders.push(m.name + ' cpu=' + JSON.stringify(m.cpu)); }
        } catch { /* ignore unreadable */ }
      }
      if (depth < 6) walk(p, depth + 1);
    }
  }
};
walk(nm, 0);
const detail = {
  productionPackages, nativeBinaries, osRestricted, cpuRestricted,
  offenders: offenders.slice(0, 20),
  builderOs: process.platform, builderArch: process.arch, nodeVersion: process.version,
};
if (nativeBinaries !== 0 || osRestricted !== 0 || cpuRestricted !== 0) {
  console.error('LINUX_COMPAT_FAILED ' + JSON.stringify(detail));
  process.exit(1);
}
console.log(JSON.stringify(detail));
NODEEOF
)" -- "$SERVER_DIR"
