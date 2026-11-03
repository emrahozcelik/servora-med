// Named disposable guest only. This is a real socket-activated systemd
// handoff, not production acceptance. The collector modules are fixture
// modules copied from the sealed installed module and the target tool; no
// service, grant or deployment outside the disposable fixture is touched.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';
import {createConnection} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, unlinkSync, writeFileSync, chmodSync, chownSync} from 'node:fs';
import {setup, reset, restore, cleanupTimeFixture, ctl, fault, faultScript} from './forward-host-systemd-fixture.mjs';
import {PATHS, TOOL_FILES, toolManifest} from '../scripts/forward-host.mjs';
import {validateHostLog} from '../scripts/forward-host-driver.mjs';
import {canonical} from '../scripts/forward-host-storage.mjs';
import {digest} from '../scripts/forward-host-evidence.mjs';

// Test-only admission clock. The socket collector, module bytes and systemd
// handoff remain real; only NTS source-report timing is removed.
process.env.FORWARD_FIXTURE_SYNTHETIC_TIME = '1';

assert.equal(process.getuid(), 0);
assert.equal(hostname(), 'lima-servora-r4-20261012');
assert.equal(process.arch, 'x64');
assert.match(execFileSync('/usr/bin/systemctl', ['--version'], {encoding: 'utf8'}), /^systemd 255 /);
assert.match(execFileSync('/usr/lib/postgresql/17/bin/psql', ['--version'], {encoding: 'utf8'}), / 17\./);

const SOURCE = '/tmp/servora-forward-src';
const VERSIONED_ROOT = '/usr/local/libexec/servora-med-forward-tools';
const EVIDENCE = '/var/lib/servora-forward-fixture/fhost-cont-01';
const MODULE = 'trusted-time.mjs';

let saved, versioned;

function dir(path, mode = 0o700) {
  mkdirSync(path, {recursive: true, mode});
  chmodSync(path, mode);
  chownSync(path, 0, 0);
}
function rootFile(path, bytes, mode = 0o644) {
  writeFileSync(path, bytes, {mode});
  chmodSync(path, mode);
  chownSync(path, 0, 0);
}
function sha(path) { return digest(readFileSync(path)); }
function show(unit, ...keys) {
  const text = ctl('show', unit, ...keys.flatMap(key => ['-p', key]));
  return Object.fromEntries(text.split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function instanceByCmdline(path) {
  // Read the kernel's own argv/cgroup view. This is deliberately not a
  // systemctl scan: the sealed RuntimeMaxSec=3 leaves only a short window to
  // observe the predecessor before the atomic switch.
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let argv, cgroup;
    try {
      argv = readFileSync('/proc/' + name + '/cmdline', 'utf8').split('\0').filter(Boolean);
      cgroup = readFileSync('/proc/' + name + '/cgroup', 'utf8');
    } catch { continue; }
    if (!argv.includes(path)) continue;
    const match = /(servora-med-time-evidence@[^/]+\.service)/.exec(cgroup);
    if (match) return {unit: match[1], pid: Number(name), argv};
  }
  return null;
}
async function waitInstance(path, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = instanceByCmdline(path);
    if (found) return found;
    await delay(20);
  }
  throw new Error('COLLECTOR_INSTANCE_NOT_OBSERVED');
}
function records(attempt) {
  const directory = attempt + '/journal';
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => /^\d{4}\.json$/.test(name)).sort()
    .map(name => JSON.parse(readFileSync(directory + '/' + name)));
}
async function waitFor(predicate, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error('TIMEOUT:' + label);
}
function openClient() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(PATHS.timeSocket);
    const fail = error => { socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('connect', () => { socket.removeListener('error', fail); resolve(socket); });
  });
}
function close(socket) { try { socket.destroy(); } catch { /* closed */ } }

function installVersionedTool() {
  dir(VERSIONED_ROOT, 0o755);
  const staging = VERSIONED_ROOT + '/.staging-' + randomUUID();
  dir(staging, 0o755);
  try {
    for (const name of TOOL_FILES) {
      const source = SOURCE + (name === 'required-checks.txt' ? '/ops/local-ci/' : '/ops/scripts/') + name;
      rootFile(staging + '/' + name, readFileSync(source), 0o644);
    }
    const manifest = toolManifest(staging);
    const target = VERSIONED_ROOT + '/' + manifest.hash;
    if (existsSync(target)) {
      rmSync(staging, {recursive: true, force: true});
      assert.equal(toolManifest(target).hash, manifest.hash);
    } else {
      renameSync(staging, target);
    }
    rootFile(target + '/manifest.json', canonical(manifest), 0o644);
    return {directory: target, hash: manifest.hash, manifest};
  } catch (error) {
    rmSync(staging, {recursive: true, force: true});
    throw error;
  }
}

function writePredecessorCollector() {
  const installed = PATHS.installed + '/trusted-time.mjs';
  const profile = JSON.parse(readFileSync(PATHS.state + '/profile.json'));
  assert.equal(sha(installed), profile.contracts.timeModuleSha256,
    'the sealed installed module must remain the fixture original');
  // The disposable predecessor is the forward-path adapter plus a benign
  // comment, so its bytes differ from the target while the real socket module
  // still accepts the legacy forward path. The sealed installed module above is
  // intentionally not used here: it predates the forward adapter path.
  const bytes = Buffer.concat([readFileSync(SOURCE + '/ops/scripts/' + MODULE),
    Buffer.from('\n// FHOST-CONT-01 disposable predecessor fixture\n')]);
  rootFile(PATHS.tool + '/' + MODULE, bytes, 0o644);
  return digest(bytes);
}

before(() => {
  saved = setup();
  versioned = installVersionedTool();
  const out = execFileSync('/usr/bin/node', ['--input-type=module', '-e',
    `import {PATHS} from ${JSON.stringify(versioned.directory + '/forward-host.mjs')};` +
    `import {toolManifest} from ${JSON.stringify(versioned.directory + '/forward-host.mjs')};` +
    'process.stdout.write(JSON.stringify({tool:PATHS.tool,manifest:toolManifest().hash}));'],
  {encoding: 'utf8'}).trim();
  const resolved = JSON.parse(out);
  assert.equal(resolved.tool, versioned.directory);
  assert.equal(resolved.manifest, versioned.hash);
  dir(EVIDENCE, 0o700);
});

test('FHOST-CONT-01A versioned collector handoff survives an in-flight predecessor across atomic drop-in, daemon-reload and the full 4500 ms drain', async () => {
  const authorization = reset(saved);
  const oldPath = PATHS.tool + '/' + MODULE;
  const newPath = versioned.directory + '/' + MODULE;
  const oldHash = writePredecessorCollector();
  const newHash = sha(newPath);
  assert.notEqual(oldHash, newHash, 'the handoff must change the collector module bytes');
  const targetHash = sha('/opt/servora-med/releases/' + authorization.target.releaseSha + '/ops/scripts/' + MODULE);
  assert.equal(newHash, targetHash, 'the versioned tool must carry the target release module');

  const {collectorExpectation, collectorSwitchPlan, atomicReplaceFile,
    assertCollectorDrainBound, COLLECTOR_DRAIN_MS} = await import(versioned.directory + '/forward-host-continuity.mjs');
  const {flushDirectory} = await import(versioned.directory + '/forward-host-storage.mjs');
  assert.equal(assertCollectorDrainBound(), 4500);

  const continuity = {kind: 'RELEASE_CONTINUITY_AUTHORIZATION', lineage: {
    predecessorCollectorPath: oldPath, predecessorCollectorModuleSha256: oldHash}};
  const options = {toolDir: versioned.directory, targetModule: newHash, installed: PATHS.installed};
  const before = collectorExpectation(continuity, {...options, complete: false});
  const after = collectorExpectation(continuity, {...options, complete: true});
  assert.equal(before.path, oldPath);
  assert.equal(after.path, newPath);
  assert.equal(after.moduleSha256, newHash);

  const dropin = PATHS.collectorDropin;
  dir(dropin.slice(0, dropin.lastIndexOf('/')), 0o755);
  rootFile(dropin, before.text, 0o600);
  ctl('daemon-reload');
  assert.equal(readFileSync(dropin, 'utf8'), before.text);
  const plan = collectorSwitchPlan({currentText: readFileSync(dropin, 'utf8'),
    oldText: before.text, newText: after.text});
  assert.deepEqual(plan, {write: true, reload: true});

  const oldClient = await openClient();
  const oldInstance = await waitInstance(oldPath);
  const oldProperties = show(oldInstance.unit, 'ActiveEnterTimestampMonotonic', 'User', 'Group',
    'ActiveState', 'SubState', 'MainPID');
  const oldStartMonoUs = Number(oldProperties.ActiveEnterTimestampMonotonic);
  assert.ok(Number.isSafeInteger(oldStartMonoUs) && oldStartMonoUs > 0);
  assert.equal(oldProperties.User, '_chrony');
  assert.equal(oldProperties.Group, '_chrony');
  assert.equal(oldProperties.ActiveState, 'active');
  assert.equal(sha(oldPath), oldHash);

  atomicReplaceFile({path: dropin, text: after.text, flush: flushDirectory});
  ctl('daemon-reload');
  const reloadedMono = performance.now();

  // systemd reloads the unit file; the running predecessor keeps its original
  // executable argv. No restart/replace of a live socket instance is expected.
  assert.ok(existsSync('/proc/' + oldInstance.pid));
  const oldArgv = readFileSync('/proc/' + oldInstance.pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
  assert.equal(oldArgv[oldArgv.indexOf(oldPath) - 1], '--no-addons');
  assert.equal(show(oldInstance.unit, 'ActiveState').ActiveState, 'active');

  const newClient = await openClient();
  const newInstance = await waitInstance(newPath);
  assert.notEqual(newInstance.pid, oldInstance.pid);
  assert.equal(show(newInstance.unit, 'User', 'Group').User, '_chrony');
  assert.equal(sha(newPath), newHash);
  assert.ok(newInstance.argv.includes('--no-addons'));
  assert.ok(newInstance.argv.includes(newPath));

  // The effect waits the full bound from the reload before it can return the
  // COLLECTOR_DONE payload. This is the exact seal boundary the journal uses.
  const remaining = COLLECTOR_DRAIN_MS - (performance.now() - reloadedMono);
  if (remaining > 0) await delay(remaining);
  const sealedMono = performance.now();
  assert.ok(sealedMono - reloadedMono >= COLLECTOR_DRAIN_MS,
    'COLLECTOR_DONE must not be sealable before the full drain');

  // The predecessor instance is bounded by the sealed unit's
  // RuntimeMaxSec=3 + TimeoutStopSec=1 and must be gone after the drain.
  const goneDeadline = Date.now() + 2500;
  let oldInfo = show(oldInstance.unit, 'ActiveState', 'SubState', 'MainPID',
    'ActiveEnterTimestampMonotonic', 'InactiveEnterTimestampMonotonic', 'Result');
  while (Date.now() < goneDeadline && ['active', 'activating', 'deactivating'].includes(oldInfo.ActiveState)) {
    await delay(20);
    oldInfo = show(oldInstance.unit, 'ActiveState', 'SubState', 'MainPID',
      'ActiveEnterTimestampMonotonic', 'InactiveEnterTimestampMonotonic', 'Result');
  }
  assert.equal(existsSync('/proc/' + oldInstance.pid), false, 'the predecessor must not survive the drain');
  const oldInactiveMonoUs = Number(oldInfo.InactiveEnterTimestampMonotonic);
  assert.ok(Number.isSafeInteger(oldInactiveMonoUs) && oldInactiveMonoUs > oldStartMonoUs,
    'systemd must record the predecessor exit');
  const oldLifetimeMs = (oldInactiveMonoUs - oldStartMonoUs) / 1000;
  assert.ok(oldLifetimeMs >= 2500 && oldLifetimeMs <= 4500,
    'predecessor lifetime must stay inside the sealed 3000 + 1000 ms bound');
  assert.equal(instanceByCmdline(oldPath), null, 'no predecessor instance may remain active');

  const effective = show('servora-med-time-evidence@forward-probe.service',
    'ExecStart', 'DropInPaths', 'NeedDaemonReload', 'FragmentPath');
  assert.equal(effective.FragmentPath, PATHS.collectorUnit);
  assert.equal(effective.DropInPaths, dropin);
  assert.equal(effective.NeedDaemonReload, 'no');
  assert.ok(effective.ExecStart.includes('--no-addons ' + newPath + ' --collect-chrony'));
  assert.equal(ctl('show', 'servora-med-time-evidence.socket', '-p', 'ActiveState', '--value'), 'active');
  assert.equal(readFileSync(dropin, 'utf8'), after.text);
  assert.equal(sha(newPath), targetHash);

  const result = {kind: 'FHOST_CONT_01_DIRECT', result: 'PASS',
    oldModulePath: oldPath, oldModuleSha256: oldHash,
    newModulePath: newPath, newModuleSha256: newHash,
    targetReleaseSha: authorization.target.releaseSha,
    oldUnit: oldInstance.unit, oldPid: oldInstance.pid,
    newUnit: newInstance.unit, newPid: newInstance.pid,
    oldLifetimeMs, drainMs: COLLECTOR_DRAIN_MS,
    sealedAfterReloadMs: sealedMono - reloadedMono,
    effectiveExecStart: effective.ExecStart, dropInPaths: effective.DropInPaths};
  rootFile(EVIDENCE + '/direct.json', canonical(result), 0o600);
  console.log('FHOST_CONT_01_DIRECT=' + JSON.stringify(result));

  close(newClient); close(oldClient);
  unlinkSync(dropin);
  ctl('daemon-reload');
  installSource();
});

test('FHOST-CONT-01B unexpected drop-in, missing target module and changed module bytes fail closed before any switch', async () => {
  reset(saved);
  writePredecessorCollector();
  const {collectorExpectation, collectorSwitchPlan} = await import(versioned.directory + '/forward-host-continuity.mjs');
  const oldPath = PATHS.tool + '/' + MODULE;
  const newPath = versioned.directory + '/' + MODULE;
  const oldHash = sha(oldPath);
  const newHash = sha(newPath);
  const continuity = {kind: 'RELEASE_CONTINUITY_AUTHORIZATION', lineage: {
    predecessorCollectorPath: oldPath, predecessorCollectorModuleSha256: oldHash}};
  const options = {toolDir: versioned.directory, targetModule: newHash, installed: PATHS.installed};
  const before = collectorExpectation(continuity, {...options, complete: false});
  const after = collectorExpectation(continuity, {...options, complete: true});

  const dropin = PATHS.collectorDropin;
  dir(dropin.slice(0, dropin.lastIndexOf('/')), 0o755);

  rootFile(dropin, '[Service]\nExecStart=\nExecStart=/bin/true\n', 0o600);
  assert.throws(() => collectorSwitchPlan({currentText: readFileSync(dropin, 'utf8'),
    oldText: before.text, newText: after.text}), /FORWARD_HOST_COLLECTOR_UNIT_DRIFT/);
  assert.equal(readFileSync(dropin, 'utf8'), '[Service]\nExecStart=\nExecStart=/bin/true\n');

  rootFile(dropin, before.text, 0o600);
  const savedBytes = readFileSync(newPath);
  rootFile(newPath, Buffer.concat([savedBytes, Buffer.from('\n// altered\n')]), 0o644);
  try {
    assert.notEqual(sha(newPath), newHash);
    const drifted = collectorExpectation(continuity, {...options, complete: true});
    assert.equal(drifted.moduleSha256, newHash);
    assert.throws(() => {
      const target = sha(newPath);
      if (target !== drifted.moduleSha256) throw new Error('FORWARD_HOST_TOOL_TARGET_MISMATCH');
    }, /FORWARD_HOST_TOOL_TARGET_MISMATCH/);
  } finally {
    rootFile(newPath, savedBytes, 0o644);
  }

  unlinkSync(newPath);
  try {
    assert.equal(existsSync(newPath), false);
    assert.throws(() => {
      if (!existsSync(versioned.directory + '/' + MODULE)) throw new Error('FORWARD_HOST_TOOL_TARGET_MISSING');
    }, /FORWARD_HOST_TOOL_TARGET_MISSING/);
  } finally {
    rootFile(newPath, savedBytes, 0o644);
  }

  unlinkSync(dropin);
  ctl('daemon-reload');
  assert.equal(sha(newPath), newHash);
});

function startApply() {
  const child = spawn('/usr/bin/bash', ['-c',
    faultScript('', 'apply', {FORWARD_FIXTURE_SYNTHETIC_TIME: '1'})],
  {stdio: ['ignore', 'pipe', 'pipe']});
  child.stderrText = '';
  child.stderr.on('data', chunk => { child.stderrText += chunk.toString(); });
  return child;
}
async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}
async function resumeToCollectorDone(attempt) {
  const started = performance.now();
  const child = startApply();
  try {
    await waitFor(() => records(attempt).some(record => record.event === 'COLLECTOR_DONE'),
      120000, 'COLLECTOR_DONE');
  } catch (error) {
    throw new Error(error.message + ' stderr=' + child.stderrText);
  } finally {
    await stopChild(child);
  }
  return {ms: performance.now() - started, stderr: child.stderrText};
}

test('FHOST-CONT-01C a drain interrupted after the atomic switch resumes with a full second 4500 ms drain and no new start or observation', async () => {
  const authorization = reset(saved);
  const attempt = PATHS.root + '/' + authorization.attemptId;
  const authSha = sha(PATHS.root + '/authorization.json');
  const toolHash = JSON.parse(readFileSync(PATHS.tool + '/manifest.json')).hash;
  const child = startApply();
  let crashed;
  try {
    await waitFor(() => records(attempt).some(record => record.event === 'COLLECTOR_INTENT'),
      120000, 'COLLECTOR_INTENT');
    await waitFor(() => {
      if (!existsSync(PATHS.collectorDropin)) return false;
      if (!readFileSync(PATHS.collectorDropin, 'utf8').includes(PATHS.tool + '/trusted-time.mjs')) return false;
      return show('servora-med-time-evidence@forward-probe.service', 'NeedDaemonReload').NeedDaemonReload === 'no';
    }, 15000, 'COLLECTOR_RELOAD');
  } finally {
    await stopChild(child);
  }
  crashed = records(attempt);
  assert.equal(crashed.some(record => record.event === 'COLLECTOR_DONE'), false);
  const pending = validateHostLog(crashed, authorization, authSha, toolHash);
  assert.equal(pending.pending?.event, 'COLLECTOR_INTENT');

  const authBefore = sha(PATHS.root + '/authorization.json');
  const dropinBefore = readFileSync(PATHS.collectorDropin, 'utf8');
  const resume = await resumeToCollectorDone(attempt);
  assert.ok(resume.ms >= 4500, 'the resumed effect must repeat the full drain: ' + resume.ms);

  const finalRecords = records(attempt);
  const count = event => finalRecords.filter(record => record.event === event).length;
  assert.equal(count('COLLECTOR_INTENT'), 1);
  assert.equal(count('COLLECTOR_DONE'), 1);
  assert.equal(count('OBSERVE_INTENT'), 0, 'a resumed collector handoff must not open an observation');
  assert.equal(count('START_DONE'), 0, 'this fixture stops at the collector boundary; no start is claimed');
  const intent = finalRecords.find(record => record.event === 'COLLECTOR_INTENT');
  const done = finalRecords.find(record => record.event === 'COLLECTOR_DONE');
  const targetHash = sha('/opt/servora-med/releases/' + authorization.target.releaseSha + '/ops/scripts/trusted-time.mjs');
  assert.equal(done.data.moduleSha256, targetHash);
  assert.equal(done.data.dropinSha256, sha(PATHS.collectorDropin));
  assert.equal(readFileSync(PATHS.collectorDropin, 'utf8'), dropinBefore);
  assert.equal(sha(PATHS.root + '/authorization.json'), authBefore, 'the grant bytes must not change');
  assert.ok(Date.parse(done.atUTC) - Date.parse(intent.atUTC) >= 4000,
    'the sealed journal must span the 4500 ms drain');
  const state = validateHostLog(finalRecords, authorization, authSha, toolHash);
  assert.ok(state.starts <= 1, 'the resumed handoff must not consume a new start slot');
  const effective = show('servora-med-time-evidence@forward-probe.service',
    'ExecStart', 'DropInPaths', 'NeedDaemonReload');
  assert.equal(effective.NeedDaemonReload, 'no');
  assert.equal(effective.DropInPaths, PATHS.collectorDropin);
  assert.ok(effective.ExecStart.includes('--no-addons ' + PATHS.tool + '/trusted-time.mjs'));
  assert.equal(instanceByCmdline(PATHS.installed + '/trusted-time.mjs'), null);

  const result = {kind: 'FHOST_CONT_01_ADAPTER_RESUME', result: 'PASS',
    attemptId: authorization.attemptId, authorizationSha256: authSha,
    targetReleaseSha: authorization.target.releaseSha, targetModuleSha256: targetHash,
    resumeToDoneMs: resume.ms,
    collectorIntentToDoneMs: Date.parse(done.atUTC) - Date.parse(intent.atUTC),
    starts: state.starts, collectorIntents: count('COLLECTOR_INTENT'),
    collectorDones: count('COLLECTOR_DONE'), observeIntents: count('OBSERVE_INTENT'),
    dropinSha256: sha(PATHS.collectorDropin), effectiveExecStart: effective.ExecStart};
  rootFile(EVIDENCE + '/adapter-resume.json', canonical(result), 0o600);
  console.log('FHOST_CONT_01_ADAPTER_RESUME=' + JSON.stringify(result));
});

test('FHOST-CONT-01D a crash after atomic rename but before daemon-reload resumes with the full drain', async () => {
  const authorization = reset(saved);
  const attempt = PATHS.root + '/' + authorization.attemptId;
  const crashed = fault('collector-before-reload', 'apply', {FORWARD_FIXTURE_SYNTHETIC_TIME: '1'});
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const afterCrash = records(attempt);
  assert.equal(afterCrash.some(record => record.event === 'COLLECTOR_INTENT'), true);
  assert.equal(afterCrash.some(record => record.event === 'COLLECTOR_DONE'), false);
  const dropinText = readFileSync(PATHS.collectorDropin, 'utf8');
  assert.ok(dropinText.includes(PATHS.tool + '/trusted-time.mjs'));

  const resume = await resumeToCollectorDone(attempt);
  assert.ok(resume.ms >= 4500, 'the reload/drain resume must repeat the full drain: ' + resume.ms);

  const finalRecords = records(attempt);
  const count = event => finalRecords.filter(record => record.event === event).length;
  assert.equal(count('COLLECTOR_INTENT'), 1);
  assert.equal(count('COLLECTOR_DONE'), 1);
  assert.equal(count('OBSERVE_INTENT'), 0);
  assert.equal(count('START_DONE'), 0);
  const intent = finalRecords.find(record => record.event === 'COLLECTOR_INTENT');
  const done = finalRecords.find(record => record.event === 'COLLECTOR_DONE');
  assert.ok(Date.parse(done.atUTC) - Date.parse(intent.atUTC) >= 4000);
  assert.equal(readFileSync(PATHS.collectorDropin, 'utf8'), dropinText);
  assert.equal(show('servora-med-time-evidence@forward-probe.service', 'NeedDaemonReload').NeedDaemonReload, 'no');
  const state = validateHostLog(finalRecords, authorization,
    sha(PATHS.root + '/authorization.json'), JSON.parse(readFileSync(PATHS.tool + '/manifest.json')).hash);
  assert.ok(state.starts <= 1);
  rootFile(EVIDENCE + '/adapter-reload-resume.json', canonical({kind: 'FHOST_CONT_01_RELOAD_RESUME',
    result: 'PASS', attemptId: authorization.attemptId, resumeToDoneMs: resume.ms,
    collectorIntentToDoneMs: Date.parse(done.atUTC) - Date.parse(intent.atUTC),
    starts: state.starts, collectorIntents: count('COLLECTOR_INTENT'),
    collectorDones: count('COLLECTOR_DONE'), dropinSha256: sha(PATHS.collectorDropin)}), 0o600);
  console.log('FHOST_CONT_01_RELOAD_RESUME=' + JSON.stringify({resumeToDoneMs: resume.ms,
    attemptId: authorization.attemptId}));
});

after(() => {
  if (!saved) return;
  try {
    if (ctl('show', 'chrony.service', '-p', 'ActiveState', '--value') !== 'active') ctl('start', 'chrony.service');
    const dropin = PATHS.collectorDropin;
    if (existsSync(dropin)) { unlinkSync(dropin); ctl('daemon-reload'); }
    if (versioned) rmSync(versioned.directory, {recursive: true, force: true});
    const remaining = existsSync(VERSIONED_ROOT) ? readdirSync(VERSIONED_ROOT) : [];
    if (!remaining.length && existsSync(VERSIONED_ROOT)) rmSync(VERSIONED_ROOT, {recursive: true, force: true});
    restore(saved);
    cleanupTimeFixture(saved);
  } catch (error) {
    process.stderr.write('FHOST_CONT_01_CLEANUP_FAILED=' + (error?.stack ?? error) + '\n');
    throw error;
  }
});

function installSource() {
  for (const name of TOOL_FILES) {
    const source = SOURCE + (name === 'required-checks.txt' ? '/ops/local-ci/' : '/ops/scripts/') + name;
    rootFile(PATHS.tool + '/' + name, readFileSync(source), 0o644);
  }
  rootFile(PATHS.tool + '/manifest.json', canonical(toolManifest()), 0o644);
}
