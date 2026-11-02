// Fault injection is test-only and requires the named disposable root guest.
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';
if (hostname() !== 'lima-servora-r4-20261012' || process.getuid() !== 0) throw new Error('FORWARD_FIXTURE_ONLY');
const requested = process.env.FORWARD_FIXTURE_FAULT;
const point = requested?.startsWith('accepted-') ? requested.slice(9) : requested;
if (requested?.startsWith('accepted-')) {
  // Fixture-only UTC offset for the explicitly synthetic accepted checkpoint.
  // No host clock or production sampler is changed.
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + 2000_000])); }
    static now() { return RealDate.now() + 2000_000; }
  };
}
const fire = name => { if (point === name) process.kill(process.pid, 'SIGKILL'); };
const injected = new Set();
function crashApplication(name) {
  if (injected.has(name)) return;
  injected.add(name);
  const pid = Number(cp.execFileSync('/usr/bin/systemctl', ['show', 'servora-med.service', '-p', 'MainPID', '--value']));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('FIXTURE_APPLICATION_PID_MISSING');
  process.kill(pid, 'SIGKILL');
}
const originalFsync = fs.fsyncSync;
fs.fsyncSync = function(fd) {
  const result = originalFsync(fd);
  let path;
  try { path = fs.readlinkSync('/proc/self/fd/' + fd); } catch { return result; }
  if (/\/forward\/[a-f0-9-]{36}\/journal\/\.publish-/.test(path)) fire('publication-before-link');
  if (/\/forward\/[a-f0-9-]{36}\/(?:recovery\/)?journal$/.test(path)) {
    const names = fs.readdirSync(path).filter(n => /^\d{4}\.json$/.test(n)).sort();
    if (names.length) {
      const record = JSON.parse(fs.readFileSync(path + '/' + names.at(-1)));
      if (path.endsWith('/recovery/journal')) {
        fire('recovery-' + record.event);
        if (record.event === 'POLICY_DONE' && point === 'recovery-runtime-crash') crashApplication(point);
      }
      else {
        if (record.event === 'PHASE') fire('phase-' + record.contract.phase);
        fire('event-' + record.event);
        if (record.event === 'OBSERVE_INTENT' && point === 'observation-process-crash') crashApplication(point);
        if (record.event === 'OBSERVE_INTENT' && point === 'observation-backup-fail')
          fs.writeFileSync('/opt/servora-med/forward-fixture-flags/backup-fail', 'SYNTHETIC FIXTURE 503\n', {mode: 0o644});
        if (record.event === 'OBSERVE_INTENT' && point === 'observation-partial-proof') {
          // A failed publication, never a successful synthetic time proof.
          fs.writeFileSync(path.slice(0, -'/journal'.length) + '/observation.json', '{"kind":"INTERRUPTED_FIXTURE_PROOF",', {mode: 0o600});
          process.kill(process.pid, 'SIGKILL');
        }
      }
    }
  }
  if (path === '/etc/systemd/system/servora-med-time-evidence@.service.d') fire('collector-before-reload');
  if (path === '/run/servora-med-recovery' && fs.existsSync('/run/servora-med-recovery/start.permit')) fire('permit-before-start');
  if (path === '/var/lib/servora-med/deploy' && point === 'owner-retired'
    && !fs.existsSync('/var/lib/servora-med/deploy/active.json')) {
    const root = '/var/lib/servora-med/deploy/forward';
    const a = JSON.parse(fs.readFileSync(root + '/authorization.json'));
    const journal = root + '/' + a.attemptId + '/recovery/journal';
    if (fs.existsSync(journal)) {
      const names = fs.readdirSync(journal).filter(n => /^\d{4}\.json$/.test(n)).sort();
      const last = names.length && JSON.parse(fs.readFileSync(journal + '/' + names.at(-1)));
      if (last.event === 'RETIRE_INTENT') { crashApplication(point); fire(point); }
    }
  }
  return result;
};
const originalExec = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  if (point === 'forced-time-unknown' && args.includes('--read-chrony')) throw new Error('TRUSTED_TIME_UNKNOWN');
  if (point === 'deny-reload' && file === '/usr/bin/systemctl' && args[0] === 'daemon-reload') fire('deny-reload');
  let result;
  try { result = originalExec(file, args, options); }
  catch (error) {
    if (file === '/usr/bin/systemctl') process.stderr.write('FIXTURE_SYSTEMCTL_FAILURE=' + args[0] + ':' + error.status + ':' + error.signal + '\n');
    throw error;
  }
  if (file === '/usr/bin/systemctl' && args[0] === 'start' && args[1] === 'servora-med.service') fire('target-started');
  return result;
};
const originalSpawn = cp.spawnSync;
cp.spawnSync = function(file, args, options) {
  if (point === 'backup-fail' && file === '/usr/bin/sudo' && args.at(-1) === 'backup') return {status: 1, stdout: '', stderr: ''};
  return originalSpawn(file, args, options);
};
syncBuiltinESMExports();
