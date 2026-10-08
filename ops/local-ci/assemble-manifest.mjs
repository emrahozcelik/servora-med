#!/usr/bin/env node
// assemble-manifest.mjs — build manifest.json + report.md from a logs dir.
//
// Usage: node assemble-manifest.mjs --bundle <dir> --sha <sha> --tree <tree>
//   --repo <origin-url> --started <iso> --finished <iso>
//   --os <s> --arch <a> --node <v> --npm <v> --pg-server <v> --pg-client <v>
//   [--compat-detail <json>]
//
// Reads <bundle>/logs/<id>.{log,exit} for every required check id; a missing
// exit file means the check never executed (result ABSENT -> overall FAIL).
// Writes manifest.json and report.md. Exits non-zero unless every check PASS.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const REQUIRED = [
  'server-static-syntax', 'server-shellcheck', 'server-systemd-units',
  'server-backup-observation', 'server-operator-alerting', 'server-caddyfile',
  'server-sse-behavior', 'server-tunnel-caddyfile', 'server-tunnel-behavior',
  'server-cloudflared-ingress', 'server-env-examples', 'server-db-auth-contract',
  'server-build', 'server-dep-smoke', 'server-migrate-schema', 'server-tests',
  'server-audit', 'web-build', 'web-bundle', 'web-tests', 'web-smoke-dist',
  'web-smoke-responsive', 'web-geometry', 'web-playwright-install', 'web-audit', 'benchmark-smoke',
  'linux-compat',
];

const COMMANDS = {
  'server-static-syntax': 'bash -n (22 scripts) + node --check (3 scripts)',
  'server-shellcheck': 'shellcheck -x (22 files)',
  'server-systemd-units': 'verify-systemd-units.sh',
  'server-backup-observation': 'verify-backup-observation.sh',
  'server-operator-alerting': 'verify-operator-alerting.sh',
  'server-caddyfile': 'verify-caddyfile.sh',
  'server-sse-behavior': 'verify-sse-streaming-behavior.sh',
  'server-tunnel-caddyfile': 'verify-tunnel-caddyfile.sh',
  'server-tunnel-behavior': 'verify-tunnel-caddy-behavior.sh',
  'server-cloudflared-ingress': 'verify-cloudflared-ingress.sh',
  'server-env-examples': 'verify-env-examples.sh',
  'server-db-auth-contract': 'verify-db-auth-contract.sh',
  'server-build': 'npm ci + npm run build (server)',
  'server-dep-smoke': 'pruned prod install + import smoke',
  'server-migrate-schema': 'tsx migrate + schema:check',
  'server-tests': 'npm test -- --run (server)',
  'server-audit': 'npm audit --audit-level=high (server)',
  'web-build': 'npm ci + build with VITE_SERVORA_BUILD_SHA',
  'web-bundle': 'npm run bundle:check',
  'web-tests': 'npm test -- --run (web)',
  'web-playwright-install': 'playwright install --with-deps chromium webkit',
  'web-smoke-dist': 'npm run smoke:production-dist',
  'web-smoke-responsive': 'npm run smoke:responsive',
  'web-geometry': 'follow-up-dialog-geometry.mjs',
  'web-audit': 'npm run audit:high',
  'benchmark-smoke': 'auth-kdf-benchmark.mjs --mode=smoke',
  'linux-compat': 'verify-linux-compat.sh',
};

const logsDir = path.join(args.bundle, 'logs');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const checks = [];
let overall = 'PASS';
for (const id of REQUIRED) {
  const log = `logs/${id}.log`;
  const exitFile = path.join(logsDir, `${id}.exit`);
  const logFile = path.join(logsDir, `${id}.log`);
  if (!fs.existsSync(exitFile) || !fs.existsSync(logFile)) {
    checks.push({ id, command: COMMANDS[id], exit: null, result: 'ABSENT', log, sha256: null, tests: null, detail: null });
    overall = 'FAIL';
    continue;
  }
  const rawExit = fs.readFileSync(exitFile, 'utf8').trim();
  const result = rawExit === 'SKIP' ? 'NOT_RUN' : rawExit === '0' ? 'PASS' : 'FAIL';
  if (result !== 'PASS') overall = 'FAIL';
  const content = fs.readFileSync(logFile, 'utf8');
  const plain = content.replace(/\[[0-9;]*m/g, '');
  const m = plain.match(/Tests\s+(?:(\d+)\s+failed\s+\|\s*)?(\d+)\s+passed/);
  const tests = m ? { failed: Number(m[1] ?? 0), passed: Number(m[2]) } : null;
  checks.push({
    id, command: COMMANDS[id], exit: rawExit === 'SKIP' ? 'SKIP' : Number(rawExit),
    result, log, sha256: sha256(logFile), tests,
    detail: id === 'linux-compat' && args['compat-detail'] ? JSON.parse(args['compat-detail']) : null,
  });
}

const manifest = {
  schemaVersion: 1,
  repo: args.repo,
  sha: args.sha,
  tree: args.tree,
  clean: true,
  builder: {
    os: args.os, arch: args.arch, node: args.node, npm: args.npm,
    pgServer: args['pg-server'], pgClient: args['pg-client'],
  },
  startedAt: args.started, finishedAt: args.finished,
  checks, result: overall,
};
fs.writeFileSync(path.join(args.bundle, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const lines = [
  `# Local CI evidence — ${args.sha}`,
  '',
  `- tree: ${args.tree}`,
  `- builder: ${args.os}/${args.arch} node ${args.node} npm ${args.npm}`,
  `- postgres: server ${args['pg-server']}, client ${args['pg-client']}`,
  `- window: ${args.started} .. ${args.finished}`,
  `- result: **${overall}**`,
  '',
  '| check | result | tests | log sha256 |',
  '|---|---|---|---|',
];
for (const c of checks) {
  const t = c.tests ? `${c.tests.passed} passed / ${c.tests.failed} failed` : '—';
  lines.push(`| ${c.id} | ${c.result} | ${t} | \`${c.sha256 ?? '—'}\` |`);
}
lines.push('');
fs.writeFileSync(path.join(args.bundle, 'report.md'), lines.join('\n'));
console.log(`manifest result: ${overall}`);
process.exit(overall === 'PASS' ? 0 : 1);
