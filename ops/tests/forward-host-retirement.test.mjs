import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostIO, PATHS, TOOL_FILES} from '../scripts/forward-host.mjs';
import {runForwardHost, validateHostLog} from '../scripts/forward-host-driver.mjs';
import {canonical, openHostJournal} from '../scripts/forward-host-storage.mjs';
import {digest, seal} from '../scripts/forward-host-evidence.mjs';
import {fixture} from './forward-host-fixture.mjs';

// Only kernel/filesystem/process boundaries are redirected. createHostIO,
// protected storage, journal validation and RETIRE effect/reconcile stay real.
// The earlier phases are synthetic fixtures, not live deployment acceptance.
async function retirementFixture(t) {
  const real = Object.fromEntries(['mkdtempSync', 'mkdirSync', 'writeFileSync', 'readFileSync',
    'existsSync', 'lstatSync', 'fstatSync', 'readdirSync', 'openSync', 'closeSync',
    'unlinkSync', 'linkSync', 'rmSync'].map(name => [name, fs[name]]));
  const directory = real.mkdtempSync(join(tmpdir(), 'servora-retirement-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const emulateRoot = process.platform !== 'linux' || process.getuid?.() !== 0;
  const descriptors = new Set();
  t.after(() => {
    t.mock.restoreAll();
    Object.defineProperty(process, 'platform', platform);
    syncBuiltinESMExports();
    real.rmSync(directory, {recursive: true, force: true});
  });
  const f = fixture();
  const state = {restart: 'on-failure', removedOwners: 0, commands: []};
  const attempt = PATHS.root + '/' + f.authorization.attemptId;
  const journal = attempt + '/journal';
  const mapped = path => typeof path === 'string' && (
    ['/var', '/usr', '/usr/local', '/usr/local/libexec', '/opt', '/etc', '/etc/systemd',
      '/etc/systemd/system', '/run'].includes(path)
    || ['/var/lib', '/usr/local/libexec/servora-med', '/opt/servora-med',
      '/etc/systemd/system/servora-med', '/run/servora-med'].some(prefix => path.startsWith(prefix)));
  const local = path => mapped(path) ? join(directory, 'root', path) : path;
  const write = (path, bytes, mode = 0o600) => {
    real.mkdirSync(dirname(local(path)), {recursive: true, mode: 0o755});
    real.writeFileSync(local(path), bytes, {mode});
  };
  const scripts = dirname(fileURLToPath(new URL('../scripts/forward-host.mjs', import.meta.url)));
  const files = TOOL_FILES.map(name => {
    const source = name === 'required-checks.txt' ? join(scripts, '../local-ci/required-checks.txt') : join(scripts, name);
    const bytes = real.readFileSync(source);
    write(PATHS.tool + '/' + name, bytes, 0o644);
    return {name, sha256: digest(bytes)};
  });
  const tool = seal({kind: 'FORWARD_HOST_TOOL', files});
  write(PATHS.tool + '/manifest.json', canonical(tool), 0o644);
  write(PATHS.root + '/authorization.json', canonical(f.authorization));
  write('/opt/servora-med/releases/' + f.authorization.target.releaseSha + '/ops/scripts/trusted-time.mjs',
    real.readFileSync(join(scripts, 'trusted-time.mjs')), 0o644);
  const owner = {attemptId: f.authorization.attemptId, approvalSha256: digest(canonical(f.authorization))};
  write(PATHS.owner, canonical(owner));
  real.mkdirSync(local(journal), {recursive: true, mode: 0o700});
  f.io.toolHash = tool.hash;
  const effect = f.io.effect;
  f.io.effect = async (op, data, log) => {
    if (op === 'OBSERVE') {
      const identity = await f.io.identity(), startedAtUTC = f.io.now();
      f.tick(1800_000);
      return {startedAtUTC, completedAtUTC: f.io.now(), seconds: 1800, samples: 61,
        pid: identity.pid, pidStartTime: identity.startTime, bootId: identity.bootId,
        endPid: identity.pid, endStartTime: identity.startTime, endBootId: identity.bootId};
    }
    if (op === 'POLICY') return effect('HANDOFF', data, log);
    return effect(op, data, log);
  };
  await runForwardHost(f.io, f.authorization, 'apply');
  await runForwardHost(f.io, f.authorization, 'smoke');
  const append = f.io.append;
  f.io.append = record => {
    append(record);
    if (record.event === 'RETIRE_INTENT') throw new Error('CRASH_BEFORE_OWNER_REMOVAL');
  };
  await assert.rejects(runForwardHost(f.io, f.authorization, 'observe'), /CRASH_BEFORE_OWNER_REMOVAL/);
  f.io.append = append;
  for (const record of f.log) write(journal + '/' + String(record.sequence).padStart(4, '0') + '.json', canonical(record));

  // Portable boundary emulation locally; Actions executes this same adapter on
  // Linux as root, using the actual metadata of its private files.
  if (emulateRoot) {
    Object.defineProperty(process, 'platform', {...platform, value: 'linux'});
    t.mock.method(process, 'getuid', () => 0);
  }
  const rootMetadata = info => Object.assign(info, {uid: 0, gid: 0});
  t.mock.method(fs, 'existsSync', path => real.existsSync(local(path)));
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const info = real.lstatSync(local(path), ...args);
    return emulateRoot && mapped(path) ? rootMetadata(info) : info;
  });
  t.mock.method(fs, 'fstatSync', (fd, ...args) => {
    const info = real.fstatSync(fd, ...args);
    return emulateRoot && descriptors.has(fd) ? rootMetadata(info) : info;
  });
  t.mock.method(fs, 'openSync', (path, ...args) => {
    const fd = real.openSync(local(path), ...args);
    if (mapped(path)) descriptors.add(fd);
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => { descriptors.delete(fd); return real.closeSync(fd); });
  for (const name of ['readFileSync', 'readdirSync', 'mkdirSync']) {
    t.mock.method(fs, name, (path, ...args) => real[name](local(path), ...args));
  }
  t.mock.method(fs, 'linkSync', (from, to) => real.linkSync(local(from), local(to)));
  t.mock.method(fs, 'unlinkSync', path => {
    const result = real.unlinkSync(local(path));
    if (path === PATHS.owner) state.removedOwners++;
    return result;
  });
  t.mock.method(childProcess, 'execFileSync', (file, args) => {
    assert.equal(file, '/usr/bin/systemctl', 'no backup, start, grant or other process may execute');
    assert.equal(args[0], 'show', 'service mutation is forbidden');
    assert.equal(args[1], 'servora-med.service');
    state.commands.push([...args]);
    return 'Restart=' + state.restart + '\n';
  });
  syncBuiltinESMExports();
  const host = await createHostIO(f.authorization);
  const io = {...f.io, readLog: host.readLog, append: host.append,
    effect: host.effect, reconcile: host.reconcile};
  const before = host.readLog();
  return {f, host, io, state, before, owner, write,
    ownerPresent: () => real.existsSync(local(PATHS.owner)),
    removeOwner: () => real.unlinkSync(local(PATHS.owner)),
    ownerBytes: () => real.existsSync(local(PATHS.owner)) ? real.readFileSync(local(PATHS.owner)) : null,
    rewriteLog: records => {
      real.rmSync(local(journal), {recursive: true, force: true});
      real.mkdirSync(local(journal), {mode: 0o700});
      for (const record of records) write(journal + '/' + String(record.sequence).padStart(4, '0') + '.json', canonical(record));
    },
    readAuthorization: () => real.readFileSync(local(PATHS.root + '/authorization.json')),
  };
}

test('real host RETIRE reconciliation finishes an interrupted owner removal', async t => {
  const r = await retirementFixture(t);
  const authorization = r.readAuthorization();
  r.io.authorizationTime = async () => { throw new Error('CONSUMED_AUTHORITY_MUST_NOT_BE_REISSUED'); };
  assert.equal(r.before.at(-1).event, 'RETIRE_INTENT');
  assert.equal(r.ownerPresent(), true);
  const result = await runForwardHost(r.io, r.f.authorization, 'finish');
  assert.equal(result.ownerRetired, true);
  assert.equal(r.ownerPresent(), false);
  assert.equal(r.state.removedOwners, 1);
  const after = r.host.readLog();
  assert.deepEqual(after.slice(0, -1), r.before, 'sealed acceptance and spent history must stay byte-equivalent');
  assert.equal(after.at(-1).event, 'RETIRE_DONE');
  assert.equal(after.filter(record => record.event === 'RETIRE_DONE').length, 1);
  assert.equal(result.starts, 1);
  assert.equal(after.filter(record => record.event === 'START_INTENT').length, 1);
  assert.equal(after.filter(record => record.event === 'OBSERVE_INTENT').length, 1);
  assert.deepEqual(r.readAuthorization(), authorization);
  validateHostLog(after, r.f.authorization, r.owner.approvalSha256, r.io.toolHash);
});

test('real host RETIRE reconciliation seals an owner removal interrupted before RETIRE_DONE', async t => {
  const r = await retirementFixture(t), append = r.io.append;
  r.io.append = record => {
    if (record.event === 'RETIRE_DONE') throw new Error('CRASH_BEFORE_RETIRE_DONE');
    append(record);
  };
  await assert.rejects(runForwardHost(r.io, r.f.authorization, 'finish'), /CRASH_BEFORE_RETIRE_DONE/);
  assert.equal(r.ownerPresent(), false);
  assert.equal(r.host.readLog().at(-1).event, 'RETIRE_INTENT');
  r.io.append = append;
  const result = await runForwardHost(r.io, r.f.authorization, 'finish');
  assert.equal(result.ownerRetired, true);
  assert.equal(r.state.removedOwners, 1);
  assert.deepEqual(r.host.readLog().slice(0, -1), r.before);
  assert.equal(r.host.readLog().filter(record => record.event === 'RETIRE_DONE').length, 1);
});

test('real host repeated finish preserves RETIRE_DONE, sealed acceptance and spent budgets', async t => {
  const r = await retirementFixture(t);
  await runForwardHost(r.io, r.f.authorization, 'finish');
  const sealed = r.host.readLog(), authorization = r.readAuthorization();
  r.io.authorizationTime = async () => { throw new Error('NO_NEW_ADMISSION'); };
  const result = await runForwardHost(r.io, r.f.authorization, 'finish');
  assert.equal(result.starts, 1);
  assert.equal(result.ownerRetired, true);
  assert.deepEqual(r.host.readLog(), sealed);
  assert.deepEqual(r.readAuthorization(), authorization);
  assert.equal(r.state.removedOwners, 1);
  for (const op of ['START', 'OBSERVE', 'PRE_BACKUP', 'POST_BACKUP', 'RETIRE']) {
    assert.equal(sealed.filter(record => record.event === op + '_INTENT').length, 1);
    assert.equal(sealed.filter(record => record.event === op + '_DONE').length, 1);
  }
});

for (const field of ['attemptId', 'approvalSha256']) {
  test('real host RETIRE rejects a foreign owner ' + field, async t => {
    const r = await retirementFixture(t);
    r.write(PATHS.owner, canonical({...r.owner, [field]: field === 'attemptId'
      ? 'ffffffff-ffff-4fff-8fff-ffffffffffff' : 'f'.repeat(64)}));
    const owner = r.ownerBytes();
    await assert.rejects(runForwardHost(r.io, r.f.authorization, 'finish'), /FORWARD_HOST_FOREIGN_OWNER/);
    assert.deepEqual(r.ownerBytes(), owner);
    assert.deepEqual(r.host.readLog(), r.before);
    assert.equal(r.state.removedOwners, 0);
  });
}

for (const absent of [false, true]) {
  for (const name of ['guard', 'barrier', 'policy', 'permit', 'ticket']) {
    test(`real host RETIRE rejects reappeared ${name} with owner ${absent ? 'absent' : 'present'}`, async t => {
      const r = await retirementFixture(t);
      if (absent) r.removeOwner();
      r.write(PATHS[name], 'unexpected\n');
      const owner = r.ownerBytes();
      await assert.rejects(runForwardHost(r.io, r.f.authorization, 'finish'), /FORWARD_HOST_RETIREMENT_INVALID/);
      assert.deepEqual(r.ownerBytes(), owner);
      assert.deepEqual(r.host.readLog(), r.before);
      assert.equal(r.state.removedOwners, 0);
    });
  }
  test(`real host RETIRE rejects unsafe restart policy with owner ${absent ? 'absent' : 'present'}`, async t => {
    const r = await retirementFixture(t);
    if (absent) r.removeOwner();
    r.state.restart = 'no';
    const owner = r.ownerBytes();
    await assert.rejects(runForwardHost(r.io, r.f.authorization, 'finish'), /FORWARD_HOST_RETIREMENT_INVALID/);
    assert.deepEqual(r.ownerBytes(), owner);
    assert.deepEqual(r.host.readLog(), r.before);
    assert.equal(r.state.removedOwners, 0);
  });
}

test('real host RETIRE rejects a journal without HANDOFF_DONE', async t => {
  const r = await retirementFixture(t);
  const records = r.before.filter(record => !record.event.startsWith('HANDOFF_'));
  const resealed = [];
  for (const record of records) {
    const {hash, ...body} = record;
    resealed.push(seal({...body, sequence: resealed.length, previousHash: resealed.at(-1)?.hash ?? null}));
  }
  r.rewriteLog(resealed);
  await assert.rejects(runForwardHost(r.io, r.f.authorization, 'finish'), /FORWARD_HOST_PHASE_CONFLICT/);
  assert.equal(r.ownerPresent(), true);
  assert.equal(r.state.removedOwners, 0);
});

test('real host RETIRE rejects altered HANDOFF evidence', async t => {
  const r = await retirementFixture(t), altered = structuredClone(r.before);
  altered.find(record => record.event === 'HANDOFF_DONE').data.restart = 'no';
  r.rewriteLog(altered);
  await assert.rejects(runForwardHost(r.io, r.f.authorization, 'finish'), /FORWARD_HOST_JOURNAL_INVALID/);
  assert.equal(r.ownerPresent(), true);
  assert.equal(r.state.removedOwners, 0);
});

test('real host RETIRE binds an absent owner retry to the current authorization', async t => {
  const r = await retirementFixture(t);
  r.removeOwner();
  const other = {...r.f.authorization, authorizationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'};
  r.write(PATHS.root + '/authorization.json', canonical(other));
  const host = await createHostIO(other);
  await assert.rejects(host.reconcile('RETIRE', r.before.at(-1), r.before), /FORWARD_HOST_JOURNAL_INVALID/);
  assert.equal(r.state.removedOwners, 0);
});

test('real host RETIRE rejects a pending record from another journal', async t => {
  const r = await retirementFixture(t), foreign = structuredClone(r.before);
  foreign.at(-1).hash = 'f'.repeat(64);
  await assert.rejects(r.host.reconcile('RETIRE', foreign.at(-1), foreign), /FORWARD_HOST_RETIREMENT_INVALID/);
  assert.deepEqual(r.host.readLog(), r.before);
  assert.equal(r.ownerPresent(), true);
});

test('real host RETIRE cannot infer completion from owner absence without its durable intent', async t => {
  const r = await retirementFixture(t);
  r.removeOwner();
  r.rewriteLog(r.before.slice(0, -1));
  await assert.rejects(r.host.reconcile('RETIRE', r.before.at(-1), r.before), /FORWARD_HOST_RETIREMENT_INVALID/);
  assert.equal(r.state.removedOwners, 0);
});
