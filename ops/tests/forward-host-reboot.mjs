// Targeted real reboot veto, not observation/host acceptance.
import assert from 'node:assert/strict';
import {readFileSync, existsSync, readdirSync, realpathSync} from 'node:fs';
import {setup, reset, restore, fault, host, ctl, write, assertImmutable} from './forward-host-systemd-fixture.mjs';
import {PATHS} from '../scripts/forward-host.mjs';
import {canonical} from '../scripts/forward-host-storage.mjs';
const marker = '/var/lib/servora-forward-fixture/reboot-case.json';
const saved = setup();
const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
if (process.argv[2] === 'prepare') {
  assert.equal(ctl('is-enabled', 'servora-med.service'), 'enabled');
  const a = reset(saved);
  const crashed = fault('event-START_INTENT'); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
  assert.equal(realpathSync(PATHS.current), '/opt/servora-med/releases/' + a.target.releaseSha);
  write(marker, canonical({kind: 'FORWARD_REBOOT_FIXTURE', bootId: boot(), attemptId: a.attemptId}));
  process.stdout.write('REBOOT_PREPARED=' + a.attemptId + '\n');
} else if (process.argv[2] === 'verify') {
  const evidence = JSON.parse(readFileSync(marker));
  try {
    assert.equal(evidence.kind, 'FORWARD_REBOOT_FIXTURE'); assert.notEqual(boot(), evidence.bootId);
    const a = JSON.parse(readFileSync(PATHS.root + '/authorization.json')); assert.equal(a.attemptId, evidence.attemptId);
    assert.equal(existsSync(PATHS.permit), false); assert.equal(existsSync(PATHS.ticket), false);
    assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
    assert.equal(ctl('show', 'servora-med.service', '-p', 'ConditionResult', '--value'), 'no');
    assert.equal(realpathSync(PATHS.current), '/opt/servora-med/releases/' + a.target.releaseSha);
    const resumed = host('apply'); assert.equal(resumed.status, 1); assert.match(resumed.stderr, /BACKUP_INVALID/);
    const directory = PATHS.root + '/' + a.attemptId;
    assert.equal(readdirSync(directory).filter(n => /^start-\d+\.json$/.test(n)).length, 0);
    const records = readdirSync(directory + '/journal').filter(n => /^\d{4}\.json$/.test(n)).map(n => JSON.parse(readFileSync(directory + '/journal/' + n)));
    assert.equal(records.filter(r => r.event === 'START_INTENT').length, 1);
    assert.equal(ctl('show', 'servora-med.service', '-p', 'MainPID', '--value'), '0');
    assertImmutable(saved); process.stdout.write('REBOOT_RECOVERY_VETO=PASS NO_START NO_BUDGET_RESET\n');
  } finally { restore(saved); }
} else throw new Error('FORWARD_REBOOT_FIXTURE_ARGUMENTS_INVALID');
