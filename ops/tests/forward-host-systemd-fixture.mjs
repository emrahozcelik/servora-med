// Targeted integration fixture, NOT host acceptance. Reuses only the explicitly
// authorized disposable guest; existing sealed emergency/parent files are inputs.
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync,
  readlinkSync, realpathSync, writeFileSync, chmodSync, chownSync, unlinkSync, rmSync, symlinkSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {TOOL_FILES, PATHS, toolManifest} from '../scripts/forward-host.mjs';
import {FORWARD_ACTIONS, FORWARD_FORBIDDEN, FORWARD_PARENT_DISPOSITION} from '../scripts/forward-transition.mjs';
import {digest, seal} from '../scripts/forward-host-evidence.mjs';
import {canonical} from '../scripts/forward-host-storage.mjs';
import {recoveryDigest} from '../scripts/forward-host-recovery.mjs';
import {timeEvidenceAt} from './trusted-time-fixture.mjs';
assert.equal(process.getuid(), 0);
assert.equal(hostname(), 'lima-servora-r4-20261012');
assert.equal(process.arch, 'x64');
assert.match(execFileSync('/usr/bin/systemctl', ['--version'], {encoding: 'utf8'}), /^systemd 255 /);
assert.match(execFileSync('/usr/lib/postgresql/17/bin/psql', ['--version'], {encoding: 'utf8'}), / 17\./);
const SOURCE = '/tmp/servora-forward-src';
const FIXTURE = '/var/lib/servora-forward-fixture';
export const TARGET = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const targetRoot = '/opt/servora-med/releases/' + TARGET;
const run = (file, args) => execFileSync(file, args, {encoding: 'utf8', timeout: 120000});
export const ctl = (...args) => run('/usr/bin/systemctl', args).trim();
export function write(path, bytes, mode = 0o600) {
  writeFileSync(path, bytes, {mode}); chmodSync(path, mode); chownSync(path, 0, 0);
}
function dir(path, mode = 0o700) { mkdirSync(path, {recursive: true, mode}); chmodSync(path, mode); chownSync(path, 0, 0); }
function contentManifest(root) {
  const entries = [];
  const walk = relative => {
    const path = join(root, relative), info = lstatSync(path), name = relative === '.' ? '.' : './' + relative;
    if (info.isSymbolicLink()) entries.push([name, 'l ' + name + ' ' + readlinkSync(path)]);
    else if (info.isDirectory()) {
      if (relative !== '.') entries.push([name, 'd ' + name]);
      for (const child of readdirSync(path)) if (!(relative === '.' && child.startsWith('.servora-release-'))) walk(relative === '.' ? child : relative + '/' + child);
    } else entries.push([name, 'f ' + name + ' ' + digest(readFileSync(path))]);
  };
  walk('.');
  entries.sort(([a, la], [b, lb]) => Buffer.compare(Buffer.from(la[0] + ' ' + a), Buffer.from(lb[0] + ' ' + b)));
  return entries.map(([, line]) => line).join('\n') + '\n';
}
function immutableSnapshot() {
  const files = [];
  const visit = path => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), info = lstatSync(file);
      if (info.isDirectory()) visit(file);
      else files.push([file, digest(readFileSync(file))]);
    }
  };
  for (const name of ['attempts', 'approvals', 'admission-proofs', 'backups', 'emergency']) visit(PATHS.state + '/' + name);
  files.push([PATHS.state + '/profile.json', digest(readFileSync(PATHS.state + '/profile.json'))]);
  return files;
}
export function setup() {
  if (existsSync(FIXTURE + '/saved.json')) {
    const saved = JSON.parse(readFileSync(FIXTURE + '/saved.json'));
    assert.equal(saved.kind, 'FORWARD_TARGETED_FIXTURE'); ensureTimeFixture(saved); return saved;
  }
  assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
  assert.equal(existsSync(PATHS.root), false); assert.equal(existsSync(PATHS.tool), false);
  assert.equal(existsSync(targetRoot), false);
  const emergencyAuth = JSON.parse(readFileSync(PATHS.state + '/emergency/authorization.json'));
  const receipt = JSON.parse(readFileSync(PATHS.state + '/emergency/' + emergencyAuth.authorizationId + '/receipt.json'));
  assert.equal(receipt.host.database.databaseName, 'servora_med_test_eh');
  assert.equal(receipt.host.releaseSha, 'e4ca2b19f7865dca3f1e4597dd099ed167667a19');
  assert.equal(receipt.operationalStatus, 'EMERGENCY_RESTART_POLICY_RESTORED');
  assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
  dir(FIXTURE);
  const saved = {kind: 'FORWARD_TARGETED_FIXTURE', oldRoot: realpathSync(PATHS.current),
    env: readFileSync(PATHS.env, 'utf8'), immutable: immutableSnapshot(), emergencyAuth, receipt};
  write(FIXTURE + '/saved.json', canonical(saved));
  ensureTimeFixture(saved);
  installSource();
  return saved;
}
function ensureTimeFixture(saved) {
  const names = ['servora-med-time-evidence@.service', 'servora-med-time-evidence.socket'];
  if (!saved.timeFixture) {
    for (const name of names) assert.equal(existsSync('/etc/systemd/system/' + name), false, 'refuse a foreign time-reader installation');
    assert.equal(existsSync(PATHS.collectorDropin), false);
    saved.timeFixture = {created: names, kind: 'OWNED_FORWARD_TIME_FIXTURE'};
    write(FIXTURE + '/saved.json', canonical(saved));
  }
  assert.equal(saved.timeFixture.kind, 'OWNED_FORWARD_TIME_FIXTURE');
  for (const name of names) {
    const source = readFileSync(SOURCE + '/ops/systemd/' + name), path = '/etc/systemd/system/' + name;
    if (existsSync(path)) assert.equal(digest(readFileSync(path)), digest(source));
    else write(path, source, 0o644);
  }
  ctl('daemon-reload'); ctl('enable', '--now', 'servora-med-time-evidence.socket');
}
export function installSource() {
  dir(PATHS.tool, 0o755);
  for (const name of TOOL_FILES) {
    const source = SOURCE + (name === 'required-checks.txt' ? '/ops/local-ci/' : '/ops/scripts/') + name;
    copyFileSync(source, PATHS.tool + '/' + name); chmodSync(PATHS.tool + '/' + name, 0o644); chownSync(PATHS.tool + '/' + name, 0, 0);
  }
  write(PATHS.tool + '/manifest.json', canonical(toolManifest()), 0o644);
}
function buildTarget(saved) {
  if (existsSync(targetRoot)) rmSync(targetRoot, {recursive: true}); // identified new fixture release only
  cpSync(saved.oldRoot, targetRoot, {recursive: true, preserveTimestamps: true});
  cpSync('/opt/servora-med/node_modules', targetRoot + '/server/node_modules', {recursive: true});
  for (const name of ['.servora-release-artifact.sha256', '.servora-release-content.sha256']) unlinkSync(targetRoot + '/' + name);
  for (const name of TOOL_FILES) {
    const relative = name === 'required-checks.txt' ? '/ops/local-ci/' + name : '/ops/scripts/' + name;
    dir(dirnameOf(targetRoot + relative), 0o755);
    copyFileSync(PATHS.tool + '/' + name, targetRoot + relative); chmodSync(targetRoot + relative, 0o644);
  }
  for (const name of ['servora-med-time-evidence@.service', 'servora-med-time-evidence.socket']) {
    copyFileSync(SOURCE + '/ops/systemd/' + name, targetRoot + '/ops/systemd/' + name);
    chmodSync(targetRoot + '/ops/systemd/' + name, 0o644); chownSync(targetRoot + '/ops/systemd/' + name, 0, 0);
  }
  const gid = Number(run('/usr/bin/id', ['-g', 'servora-med']).trim());
  for (const path of [targetRoot, targetRoot + '/ops', targetRoot + '/ops/scripts']) { chmodSync(path, 0o750); chownSync(path, 0, gid); }
  chmodSync(targetRoot + '/ops/scripts/trusted-time.mjs', 0o650); chownSync(targetRoot + '/ops/scripts/trusted-time.mjs', 0, gid);
  write(targetRoot + '/server/dist/db/schema-check.js', '// Synthetic fixture schema gate, not application schema acceptance.\nimport {existsSync} from "node:fs"; process.exit(existsSync("/opt/servora-med/forward-fixture-flags/schema-fail") ? 1 : 0);\n', 0o644);
  dir('/opt/servora-med/forward-fixture-flags', 0o755);
  write(targetRoot + '/server/dist/index.js', `
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
const flags='/opt/servora-med/forward-fixture-flags/';
setInterval(()=>{if(existsSync(flags+'unknown-exe'))process.execve('/usr/bin/sleep',['sleep','120'],process.env);},100).unref();
createServer((req,res)=>{
  const backup=req.url==='/api/health/backup';
  if(existsSync(flags+(backup?'backup-fail':'health-fail'))){res.writeHead(503);res.end('{}');return;}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(backup?{status:'ok',provider:'host-observation',providerStatus:'healthy',latestScheduledVerifiedAt:new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z')}:{status:'ok',releaseSha:process.env.SERVORA_RELEASE_SHA}));
}).listen(3000,'127.0.0.1');
`, 0o644);
  const archive = PATHS.state + '/artifacts/' + TARGET + '.tar.gz';
  if (existsSync(archive)) unlinkSync(archive); // this fixture's identified archive
  run('/usr/bin/tar', ['-czf', archive, '-C', targetRoot, '.']); chmodSync(archive, 0o600);
  const artifactSha256 = digest(readFileSync(archive));
  write(targetRoot + '/.servora-release-artifact.sha256', artifactSha256 + '\n');
  write(targetRoot + '/.servora-release-content.sha256', contentManifest(targetRoot));
  return artifactSha256;
}
const dirnameOf = path => path.slice(0, path.lastIndexOf('/'));
export function reset(saved) {
  assert.equal(saved.receipt.host.database.databaseName, 'servora_med_test_eh');
  assert.equal(saved.receipt.host.releaseSha, 'e4ca2b19f7865dca3f1e4597dd099ed167667a19');
  preserveForwardFixture();
  ctl('stop', 'servora-med.service');
  if (existsSync(PATHS.owner)) {
    const owner = JSON.parse(readFileSync(PATHS.owner));
    assert.equal(owner.attemptId, JSON.parse(readFileSync(PATHS.root + '/authorization.json')).attemptId);
    unlinkSync(PATHS.owner);
  }
  for (const path of [PATHS.barrier, PATHS.guard, PATHS.policy, PATHS.ticket, PATHS.permit, PATHS.collectorDropin]) if (existsSync(path)) unlinkSync(path);
  dir('/opt/servora-med/forward-fixture-flags', 0o755);
  for (const name of readdirSync('/opt/servora-med/forward-fixture-flags')) unlinkSync('/opt/servora-med/forward-fixture-flags/' + name);
  if (existsSync(PATHS.root)) rmSync(PATHS.root, {recursive: true});
  dir(PATHS.root); installSource();
  if (existsSync(PATHS.current)) unlinkSync(PATHS.current);
  symlinkSync(saved.oldRoot, PATHS.current);
  write(PATHS.env, saved.env, 0o640); chownSync(PATHS.env, 0, Number(run('/usr/bin/id', ['-g', 'servora-med']).trim()));
  ctl('daemon-reload'); spawnSync('/usr/bin/systemctl', ['reset-failed', 'servora-med.service']); ctl('start', 'servora-med.service');
  const artifactSha256 = buildTarget(saved);
  const parent = JSON.parse(readFileSync(PATHS.state + '/approvals/' + saved.receipt.parent.attemptId + '.json'));
  const attemptId = randomUUID();
  const ci = PATHS.root + '/ci/' + TARGET; dir(ci + '/logs/aux');
  const required = readFileSync(PATHS.tool + '/required-checks.txt', 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  const checks = required.map(id => {
    const log = 'logs/' + id + '.log', bytes = 'SYNTHETIC FIXTURE ONLY: ' + id + '\n'; write(ci + '/' + log, bytes);
    return {id, result: 'PASS', log, sha256: digest(bytes), ...(id === 'linux-compat' ? {detail: {nativeBinaries: 0, osRestricted: 0, cpuRestricted: 0, linuxAmd64: {result: 'pass', productionPackages: 1}}} : {})};
  });
  write(ci + '/logs/aux/cleanup.log', 'fixture retained\n'); write(ci + '/logs/aux/cleanup.status', 'PASS\n');
  const manifest = {schemaVersion: 2, sha: TARGET, tree: 'b'.repeat(40), result: 'PASS', provenance: 'local-operator-attested', builder: {os: 'linux-fixture', arch: 'x64', node: process.version}, checks,
    cleanup: {result: 'PASS', mode: 'keep-containers', log: {path: 'logs/aux/cleanup.log', sha256: digest('fixture retained\n')}, status: {path: 'logs/aux/cleanup.status', sha256: digest('PASS\n')}}};
  write(ci + '/manifest.json', canonical(manifest));
  const r = saved.receipt;
  const issuedTime = fixtureTime();
  const a = {formatVersion: 2, kind: 'FORWARD_TRANSITION_AUTHORIZATION', authorizationId: randomUUID(),
    issuedAtUTC: issuedTime.wallAtUTC.replace(/\.\d{3}Z$/, 'Z'), expiresAtUTC: new Date(Date.parse(issuedTime.wallAtUTC) + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), issuedTime,
    maxUses: 1, reason: 'SYNTHETIC_TARGETED_HOST_FIXTURE', scope: 'FORWARD_ONLY_RELEASE_TRANSITION', attemptId,
    parent: {attemptId: r.parent.attemptId, approvalSha256: r.parent.approvalSha256, profileSha256: r.parent.profileSha256,
      checkpointSequence: r.parent.checkpointSequence, checkpointSha256: r.parent.checkpointSha256,
      emergencyAuthorizationId: r.authorizationId, emergencyJournalHeadSha256: r.handoff.journalHeadSha256, emergencyReceiptSha256: r.hash, disposition: FORWARD_PARENT_DISPOSITION},
    old: {releaseSha: r.host.releaseSha, artifactSha256: parent.artifactSha256, schemaHead: r.host.schemaHead, catalog: parent.targetCatalog},
    target: {releaseSha: TARGET, treeSha: manifest.tree, artifactSha256, ciManifestSha256: digest(canonical(manifest)), schemaHead: r.host.schemaHead, catalog: parent.targetCatalog},
    host: {machineId: r.host.machineId, database: r.host.database}, migration: {allowed: false, required: false, authorizedMigrations: []},
    budgets: {maxStarts: 2, maxObservationAttempts: 1}, actions: [...FORWARD_ACTIONS], forbidden: [...FORWARD_FORBIDDEN]};
  write(PATHS.root + '/authorization.json', canonical(a));
  waitHealth(a.old.releaseSha); return a;
}
/** Synthetic issuance data only. Positive CLI admission/START still require
 * the real restricted sampler; these fixture values cannot replace it. */
export function fixtureTime() {
  const before = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  const wall = Date.now(), after = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  return timeEvidenceAt(wall, {bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    timeNamespaceId: readlinkSync('/proc/self/ns/time'), bootLowerMs: Math.max(0, Math.floor(before) - 10), bootUpperMs: Math.ceil(after) + 10});
}
/** Keep raw grants/journals/dumps inside the same private disposable VM.
 * This is not an export or deployment evidence bundle. */
export function preserveForwardFixture() {
  if (!existsSync(PATHS.root + '/authorization.json')) return;
  const a = JSON.parse(readFileSync(PATHS.root + '/authorization.json'));
  assert.equal(a.reason, 'SYNTHETIC_TARGETED_HOST_FIXTURE');
  assert.equal(a.target.releaseSha, TARGET); assert.equal(a.host.database.databaseName, 'servora_med_test_eh');
  assert.match(a.attemptId, /^[a-f0-9-]{36}$/);
  const root = FIXTURE + '/final-safety-retained'; dir(root);
  const destination = root + '/' + a.attemptId;
  if (!existsSync(destination)) cpSync(PATHS.root, destination, {recursive: true, preserveTimestamps: true});
  else assert.equal(digest(readFileSync(destination + '/authorization.json')), digest(readFileSync(PATHS.root + '/authorization.json')));
}
export function waitHealth(sha) {
  for (let i = 0; i < 50; i++) {
    const result = spawnSync('/usr/bin/curl', ['-fsS', '--max-time', '2', 'http://127.0.0.1:3000/api/health'], {encoding: 'utf8'});
    try { if (JSON.parse(result.stdout).releaseSha === sha) return; } catch { /* startup */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error('FIXTURE_HEALTH_TIMEOUT');
}
export function host(command, extraEnv = {}) {
  return spawnSync('/usr/bin/node', [PATHS.tool + '/forward-host.mjs', command], {encoding: 'utf8', timeout: 240000, env: {...process.env, ...extraEnv}});
}
export function recoveryFixtureGrant(a, mode = 'RESTORE_HEALTHY_TARGET') {
  const status = host('recovery-status'); assert.equal(status.status, 0, status.stderr);
  const {snapshot, uptimeMs} = JSON.parse(status.stdout), attempt = PATHS.root + '/' + a.attemptId;
  const names = readdirSync(attempt + '/journal').filter(n => /^\d{4}\.json$/.test(n)).sort();
  const latest = JSON.parse(readFileSync(attempt + '/journal/' + names.at(-1)));
  const grant = {formatVersion: 1, kind: 'FORWARD_FAILURE_RECOVERY_AUTHORIZATION', authorizationId: randomUUID(),
    attemptId: a.attemptId, scope: 'FORWARD_FAILURE_RECOVERY', mode, onFailure: 'CLOSE_FENCED', maxUses: 1,
    bootId: snapshot.bootId, issuedUptimeMs: uptimeMs, expiresUptimeMs: uptimeMs + 3590_000,
    issuedAtUTC: new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAtUTC: new Date(Date.now() + 3590_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), reason: 'SYNTHETIC_TARGETED_RECOVERY_FIXTURE',
    deploymentAuthorizationSha256: recoveryDigest(a), deploymentJournalHeadSha256: latest.hash,
    toolHash: JSON.parse(readFileSync(PATHS.tool + '/manifest.json')).hash, snapshotSha256: recoveryDigest(snapshot)};
  write(attempt + '/recovery-authorization.json', canonical(grant)); return grant;
}
export function fault(point, command = 'apply') {
  assert.match(point, /^[A-Za-z0-9_-]+$/);
  assert.ok(['apply', 'smoke', 'finish', 'status', 'preflight', 'observe', 'recover', 'recovery-status'].includes(command));
  const script = 'exec 9<>/var/lib/servora-med/deploy/host.lock\n/usr/bin/flock -n 9 || exit 90\n' +
    'exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin SERVORA_FORWARD_LOCKED=1 SERVORA_FORWARD_LOCK_FD=9 ' +
    'FORWARD_FIXTURE_FAULT=' + point + ' /usr/bin/node --import=' + SOURCE + '/ops/tests/forward-host-fault-preload.mjs ' + PATHS.tool + '/forward-host.mjs ' + command;
  return spawnSync('/usr/bin/bash', ['-c', script], {encoding: 'utf8', timeout: 240000});
}
export function assertImmutable(saved) { assert.deepEqual(immutableSnapshot(), saved.immutable); }
export function readOnlySnapshot() {
  const entries = [];
  const walk = path => {
    const info = lstatSync(path);
    entries.push([path, info.mode, info.uid, info.gid, info.nlink, info.ino, info.size, info.mtimeMs, info.ctimeMs,
      info.isFile() ? digest(readFileSync(path)) : info.isSymbolicLink() ? readlinkSync(path) : null]);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(PATHS.root);
  for (const path of [PATHS.env, PATHS.current, PATHS.state + '/host.lock']) walk(path);
  return {entries, pid: ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'),
    restart: ctl('show', 'servora-med.service', '-p', 'Restart', '--value'),
    owner: existsSync(PATHS.owner), barrier: existsSync(PATHS.barrier), permit: existsSync(PATHS.permit)};
}
export function smokeReceipt(a) {
  const directory = PATHS.root + '/' + a.attemptId;
  const names = readdirSync(directory + '/journal').filter(n => /^\d{4}\.json$/.test(n)).sort();
  const latest = JSON.parse(readFileSync(directory + '/journal/' + names.at(-1)));
  assert.equal(latest.contract.phase, 'HEALTH_PASSED');
  const pid = Number(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'));
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  write(directory + '/smoke.log', 'SYNTHETIC FIXTURE browser boundary only; no browser acceptance\n');
  write(directory + '/smoke.json', canonical(seal({kind: 'FORWARD_HOST_BROWSER_SMOKE', result: 'PASS',
    attemptId: a.attemptId, authorizationSha256: digest(canonical(a)), targetReleaseSha: a.target.releaseSha,
    healthPhaseHash: latest.contract.hash, browser: 'chromium',
    identity: {pid, startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), invocationId: ctl('show', 'servora-med.service', '-p', 'InvocationID', '--value')},
    completedAtUTC: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), logSha256: digest(readFileSync(directory + '/smoke.log'))})));
}
export function restore(saved) {
  ctl('stop', 'servora-med.service');
  const a = existsSync(PATHS.root + '/authorization.json') ? JSON.parse(readFileSync(PATHS.root + '/authorization.json')) : null;
  for (const path of [PATHS.owner, PATHS.barrier]) if (existsSync(path)) {
    assert.equal(JSON.parse(readFileSync(path)).attemptId, a?.attemptId); unlinkSync(path);
  }
  for (const path of [PATHS.guard, PATHS.policy, PATHS.ticket, PATHS.permit, PATHS.collectorDropin]) if (existsSync(path)) unlinkSync(path);
  unlinkSync(PATHS.current); symlinkSync(saved.oldRoot, PATHS.current);
  write(PATHS.env, saved.env, 0o640); chownSync(PATHS.env, 0, Number(run('/usr/bin/id', ['-g', 'servora-med']).trim()));
  ctl('daemon-reload'); spawnSync('/usr/bin/systemctl', ['reset-failed', 'servora-med.service']); ctl('start', 'servora-med.service');
  waitHealth(saved.receipt.host.releaseSha); assertImmutable(saved);
}
/** Restore the originally absent reader units, only after all owned tests end.
 * Never use this against a pre-existing or drifted installation. */
export function cleanupTimeFixture(saved) {
  assert.equal(saved.timeFixture?.kind, 'OWNED_FORWARD_TIME_FIXTURE');
  assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
  assert.equal(existsSync(PATHS.collectorDropin), false);
  assert.equal(realpathSync(PATHS.current), saved.oldRoot);
  const active = ctl('list-units', '--all', '--type=service', '--state=active,activating,deactivating', '--plain', '--no-legend', 'servora-med-time-evidence@*.service');
  assert.equal(active, '', 'HOLD: active reader instance');
  for (const name of saved.timeFixture.created) {
    assert.ok(['servora-med-time-evidence@.service', 'servora-med-time-evidence.socket'].includes(name));
    assert.equal(digest(readFileSync('/etc/systemd/system/' + name)), digest(readFileSync(SOURCE + '/ops/systemd/' + name)));
  }
  ctl('disable', '--now', 'servora-med-time-evidence.socket');
  for (const name of saved.timeFixture.created) unlinkSync('/etc/systemd/system/' + name);
  ctl('daemon-reload'); assertImmutable(saved);
}
