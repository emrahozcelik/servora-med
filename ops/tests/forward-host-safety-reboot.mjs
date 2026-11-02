// Two targeted real-reboot cases. Accepted checkpoints are explicitly
// synthetic terminal-I/O fixtures, never genuine time/observation acceptance.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {setup, reset, restore, fault, host, ctl, smokeReceipt, write,
  assertImmutable, recoveryFixtureGrant} from './forward-host-systemd-fixture.mjs';
import {PATHS} from '../scripts/forward-host.mjs';
import {canonical} from '../scripts/forward-host-storage.mjs';
import {validateHostLog} from '../scripts/forward-host-driver.mjs';
import {validateRecoveryLog, recoveryDigest} from '../scripts/forward-host-recovery.mjs';
const marker = '/var/lib/servora-forward-fixture/safety-reboot.json';
const saved = setup(), [action, mode] = process.argv.slice(2);
assert.ok(['observation', 'accepted'].includes(mode));
const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const read = path => readdirSync(path).filter(n => /^\d{4}\.json$/.test(n)).sort().map(n => JSON.parse(readFileSync(path + '/' + n)));
if (action === 'prepare') {
  assert.equal(ctl('is-enabled', 'servora-med.service'), 'enabled');
  const a = reset(saved);
  const applied = host('apply'); assert.equal(applied.status, 0, applied.stderr);
  smokeReceipt(a); const smoked = host('smoke'); assert.equal(smoked.status, 0, smoked.stderr);
  if (mode === 'observation') {
    const crashed = fault('event-OBSERVE_INTENT', 'observe'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  } else execFileSync('/usr/bin/flock', ['--nonblock', PATHS.state + '/host.lock', '/usr/bin/node', '/tmp/servora-forward-src/ops/tests/forward-host-terminal-fixture.mjs']);
  const records = read(PATHS.root + '/' + a.attemptId + '/journal');
  write(marker, canonical({kind: 'FORWARD_SAFETY_REBOOT_FIXTURE', mode, bootId: boot(), attemptId: a.attemptId,
    head: records.at(-1).hash, startIdentity: records.find(r => r.event === 'START_DONE').data.identity}));
  process.stdout.write('SAFETY_REBOOT_PREPARED=' + mode + '\n');
} else if (action === 'verify') {
  const evidence = JSON.parse(readFileSync(marker));
  try {
    assert.equal(evidence.kind, 'FORWARD_SAFETY_REBOOT_FIXTURE'); assert.equal(evidence.mode, mode);
    assert.notEqual(boot(), evidence.bootId);
    const a = JSON.parse(readFileSync(PATHS.root + '/authorization.json'));
    assert.equal(a.attemptId, evidence.attemptId);
    const path = PATHS.root + '/' + a.attemptId, original = read(path + '/journal');
    const toolHash = JSON.parse(readFileSync(PATHS.tool + '/manifest.json')).hash;
    validateHostLog(original, a, recoveryDigest(a), toolHash);
    assert.equal(original.at(-1).hash, evidence.head);
    assert.equal(original.filter(r => r.event === 'START_INTENT').length, 1);
    assert.equal(existsSync(PATHS.owner), true); assert.equal(existsSync(PATHS.barrier), true);
    assert.equal(existsSync(PATHS.permit), false); assert.equal(existsSync(PATHS.ticket), false);
    assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
    assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), mode === 'accepted' ? 'on-failure' : 'no');
    if (mode === 'observation') {
      const g = recoveryFixtureGrant(a, 'CLOSE_FENCED');
      const closed = host('recover'); assert.equal(closed.status, 0, closed.stderr);
      assert.equal(JSON.parse(closed.stdout).outcome, 'FORWARD_FAILURE_FENCED_NOT_ACCEPTED');
      assert.deepEqual(read(path + '/journal'), original);
      validateRecoveryLog(read(path + '/recovery/journal'), g, a, original, toolHash);
      assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
      assert.equal(existsSync(PATHS.owner), true); assert.equal(existsSync(PATHS.barrier), true);
    } else {
      const finished = fault('accepted-none', 'finish'); assert.equal(finished.status, 0, finished.stderr);
      assert.equal(JSON.parse(finished.stdout).ownerRetired, true);
      assert.equal(ctl('show', 'servora-med.service', '-p', 'Restart', '--value'), 'on-failure');
      assert.notEqual(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
      assert.equal(existsSync(PATHS.owner), false); assert.equal(existsSync(PATHS.barrier), false);
    }
    const final = read(path + '/journal'); validateHostLog(final, a, recoveryDigest(a), toolHash);
    assert.equal(final.filter(r => r.event === 'START_INTENT').length, 1);
    assert.equal(final.filter(r => r.event === 'OBSERVE_INTENT').length, 1);
    assertImmutable(saved); process.stdout.write('SAFETY_REBOOT_PASS=' + mode + ':NO_BUDGET_RESET\n');
  } finally { restore(saved); }
} else throw new Error('FIXTURE_ACTION_INVALID');
