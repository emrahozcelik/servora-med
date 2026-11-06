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
// The EXIT trap subsequently calls --finalize-cleanup <bundle>
// --cleanup-mode <remove|keep-containers>. Until then evidence is provisional.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

// The test manifest is provisional until the EXIT trap completes resource
// cleanup under the run lock. Bind its independent result and exact file bytes
// without changing the original 27-check result or the caller's exit status.
if (args['finalize-cleanup']) {
  const bundle = args['finalize-cleanup'];
  const file = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schemaVersion !== 2 || !['remove', 'keep-containers'].includes(args['cleanup-mode'])) {
    throw new Error('CLEANUP_EVIDENCE_INVALID');
  }
  const entry = (name) => ({ path: name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle, name))).digest('hex') });
  const status = fs.readFileSync(path.join(bundle, 'logs/aux/cleanup.status'), 'utf8');
  if (!['PASS\n', 'FAIL\n'].includes(status)) throw new Error('CLEANUP_STATUS_INVALID');
  manifest.cleanup = { result: status.trim(), mode: args['cleanup-mode'], log: entry('logs/aux/cleanup.log'), status: entry('logs/aux/cleanup.status') };
  fs.appendFileSync(path.join(bundle, 'report.md'), `\n- cleanup: **${manifest.cleanup.result}** (mode: ${manifest.cleanup.mode}); acceptance also requires all 27 checks PASS.\n`);
  const temporary = `${file}.cleanup-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temporary, file);
  console.log(`EVIDENCE_CLEANUP_FINALIZED result=${manifest.cleanup.result} mode=${manifest.cleanup.mode}`);
  process.exit(0);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = fs.readFileSync(path.join(SCRIPT_DIR, 'required-checks.txt'), 'utf8')
  .split('\n').filter((l) => l && !l.startsWith('#'));
if (!REQUIRED.length || new Set(REQUIRED).size !== REQUIRED.length
    || REQUIRED.some((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
  throw new Error('EVIDENCE_POLICY_INVALID');
}

const COMMANDS = {
  'server-static-syntax': 'bash -n + node --check (ops and local-CI tooling)',
  'server-shellcheck': 'shellcheck -x (ops and local-CI tooling)',
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
  'web-playwright-install': 'lockfile/toolchain match + cached Chromium and WebKit launch/render',
  'web-smoke-dist': 'npm run smoke:production-dist',
  'web-smoke-responsive': 'npm run smoke:responsive',
  'web-geometry': 'reports-ui-smoke.mjs + follow-up-dialog-geometry.mjs',
  'web-audit': 'npm run audit:high',
  'benchmark-smoke': 'auth-kdf-benchmark.mjs --mode=smoke',
  'linux-compat': 'verify-linux-compat.sh',
};

const logsDir = path.join(args.bundle, 'logs');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const checks = [];
const chains = { server: Number(args['server-chain-exit'] ?? 0), web: Number(args['web-chain-exit'] ?? 0) };
let overall = Object.values(chains).every((code) => code === 0) ? 'PASS' : 'FAIL';
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
  schemaVersion: 2,
  repo: args.repo,
  sha: args.sha,
  tree: args.tree,
  clean: true,
  // Provenance claim (see lib/evidence.sh trust model): "local-operator-
  // attested" means internally consistent + reproducible, NOT independently
  // authenticated. The verifier refuses any other value.
  provenance: 'local-operator-attested',
  builder: {
    os: args.os, arch: args.arch, node: args.node, npm: args.npm,
    pgServer: args['pg-server'], pgClient: args['pg-client'],
  },
  startedAt: args.started, finishedAt: args.finished,
  checks, chains, result: overall,
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
