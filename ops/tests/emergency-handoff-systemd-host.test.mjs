// Real systemd 255 condition/restart contract for the emergency handoff.
//
// Verified behavior that determines the handoff order:
// - manual start/restart evaluates ConditionPathExists (barrier blocks it);
// - an automatic Restart=on-failure job does NOT re-evaluate the conditions;
// - after a reboot the unit is started fresh, so the volatile permit loss and
//   the durable barrier do apply.
//
// Therefore the policy-first order is the crash-safe order: restore
// Restart=on-failure first (a crash is automatically restarted even while the
// barrier is still present), then remove the barrier to re-enable manual boot
// starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {hostname} from 'node:os';
import {spawnSync} from 'node:child_process';

assert.equal(hostname(), 'lima-servora-r4-20261012');
assert.equal(process.getuid(), 0);
assert.equal(readFileSync('/proc/1/comm', 'utf8').trim(), 'systemd');

const ROOT = '/var/lib/servora-eh-systemd';
const BARRIER = ROOT + '/barrier';
const PERMIT = ROOT + '/permit';
const STARTS = ROOT + '/starts';
const UNIT = '/etc/systemd/system/servora-eh-systemd-probe.service';
const DROPIN = '/etc/systemd/system/servora-eh-systemd-probe.service.d/90-restart-no.conf';
const run = (...args) => spawnSync('/usr/bin/systemctl', args, {encoding: 'utf8'});
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const show = property => run('show', 'servora-eh-systemd-probe.service', '-p', property, '--value')
  .stdout.trim();
const active = () => show('ActiveState');
const started = () => existsSync(STARTS) ? readFileSync(STARTS, 'utf8').split('\n').filter(Boolean).length : 0;
const killMain = () => {
  const pid = Number(show('MainPID'));
  assert.ok(pid > 0);
  process.kill(pid, 'SIGKILL');
};
const start = () => run('start', 'servora-eh-systemd-probe.service');

test('systemd 255: policy-first makes a crash restart effective before the barrier is removed', () => {
  rmSync(ROOT, {recursive: true, force: true});
  mkdirSync(ROOT, {recursive: true, mode: 0o755});
  mkdirSync(DROPIN.slice(0, DROPIN.lastIndexOf('/')), {recursive: true, mode: 0o755});
  writeFileSync(ROOT + '/probe.mjs', `
import {appendFileSync} from 'node:fs';
appendFileSync('${STARTS}', process.pid + '\\n');
setInterval(() => {}, 1000);
`, {mode: 0o644});
  writeFileSync(UNIT, `[Unit]
Description=Emergency handoff systemd probe
ConditionPathExists=|!${BARRIER}
ConditionPathExists=|${PERMIT}

[Service]
Type=simple
ExecStart=/usr/bin/node ${ROOT}/probe.mjs
Restart=on-failure
RestartSec=1
TimeoutStopSec=2

[Install]
WantedBy=multi-user.target
`, {mode: 0o644});
  chmodSync(UNIT, 0o644);
  writeFileSync(DROPIN, '[Service]\nRestart=no\n', {mode: 0o644});
  chmodSync(DROPIN, 0o644);
  try {
    assert.equal(run('daemon-reload').status, 0);
    run('stop', 'servora-eh-systemd-probe.service');
    run('reset-failed', 'servora-eh-systemd-probe.service');

    // 0. The R4 status quo: Restart=no + barrier. A crash stays down.
    writeFileSync(BARRIER, 'barrier\n', {mode: 0o600});
    assert.equal(show('Restart'), 'no');
    assert.equal(start().status, 0);
    wait(500);
    assert.equal(active(), 'inactive', 'manually starting under the barrier is refused');
    run('reset-failed', 'servora-eh-systemd-probe.service');

    // Start normally, then install the recovery policy while running.
    rmSync(BARRIER, {force: true});
    assert.equal(start().status, 0);
    wait(800);
    assert.equal(active(), 'active');
    writeFileSync(BARRIER, 'barrier\n', {mode: 0o600});
    const baselineStarts = started();
    killMain();
    wait(4000);
    assert.notEqual(active(), 'active', 'Restart=no must not restart the crashed app');
    assert.equal(started(), baselineStarts);

    // 1. Policy-first: remove the drop-in only. The barrier remains.
    rmSync(DROPIN, {force: true});
    assert.equal(run('daemon-reload').status, 0);
    assert.equal(show('Restart'), 'on-failure');
    assert.equal(run('show', 'servora-eh-systemd-probe.service', '-p', 'DropInPaths', '--value').stdout.trim(), '');
    run('reset-failed', 'servora-eh-systemd-probe.service');
    // Manual start is still blocked by the barrier (the condition IS checked).
    assert.equal(start().status, 0);
    wait(500);
    assert.equal(active(), 'inactive');
    assert.equal(show('ConditionResult'), 'no');

    // A manual start with a one-shot permit proves the OR semantics.
    writeFileSync(PERMIT, 'permit\n', {mode: 0o600});
    assert.equal(start().status, 0);
    wait(800);
    assert.equal(active(), 'active');
    rmSync(PERMIT, {force: true});
    const beforeCrash = started();
    killMain();
    wait(4500);
    assert.equal(active(), 'active',
      'automatic restart must ignore the barrier once Restart=on-failure is effective');
    assert.ok(started() > beforeCrash, 'the automatic restart executed the probe');
    assert.ok(Number(show('NRestarts')) >= 1);

    // 2. Barrier removal only re-enables manual/boot starts.
    rmSync(BARRIER, {force: true});
    assert.equal(run('restart', 'servora-eh-systemd-probe.service').status, 0);
    wait(800);
    assert.equal(active(), 'active');
    const afterManual = started();
    killMain();
    wait(4500);
    assert.equal(active(), 'active');
    assert.ok(started() > afterManual);

    // 3. A reboot is a fresh start: the durable barrier blocks it, the
    // volatile permit would be gone. This is why resume, not assumption, is
    // required after an interrupted handoff.
    writeFileSync(BARRIER, 'barrier\n', {mode: 0o600});
    assert.equal(run('restart', 'servora-eh-systemd-probe.service').status, 0);
    wait(500);
    assert.equal(active(), 'inactive');
  } finally {
    run('stop', 'servora-eh-systemd-probe.service');
    run('reset-failed', 'servora-eh-systemd-probe.service');
    rmSync(UNIT, {force: true});
    rmSync(DROPIN, {force: true});
    rmSync(DROPIN.slice(0, DROPIN.lastIndexOf('/')), {recursive: true, force: true});
    run('daemon-reload');
    rmSync(ROOT, {recursive: true, force: true});
  }
});
