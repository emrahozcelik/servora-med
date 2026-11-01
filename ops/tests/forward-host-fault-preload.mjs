// Fault injection is test-only and requires the named disposable root guest.
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';
if (hostname() !== 'lima-servora-r4-20261012' || process.getuid() !== 0) throw new Error('FORWARD_FIXTURE_ONLY');
const point = process.env.FORWARD_FIXTURE_FAULT;
const fire = name => { if (point === name) process.kill(process.pid, 'SIGKILL'); };
const originalFsync = fs.fsyncSync;
fs.fsyncSync = function(fd) {
  const result = originalFsync(fd);
  let path;
  try { path = fs.readlinkSync('/proc/self/fd/' + fd); } catch { return result; }
  if (/\/forward\/[a-f0-9-]{36}\/journal\/\.publish-/.test(path)) fire('publication-before-link');
  if (/\/forward\/[a-f0-9-]{36}\/journal$/.test(path)) {
    const names = fs.readdirSync(path).filter(n => /^\d{4}\.json$/.test(n)).sort();
    if (names.length) {
      const record = JSON.parse(fs.readFileSync(path + '/' + names.at(-1)));
      if (record.event === 'PHASE') fire('phase-' + record.contract.phase);
      fire('event-' + record.event);
    }
  }
  if (path === '/etc/systemd/system/servora-med-time-evidence@.service.d') fire('collector-before-reload');
  return result;
};
const originalExec = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  if (point === 'deny-reload' && file === '/usr/bin/systemctl' && args[0] === 'daemon-reload') fire('deny-reload');
  const result = originalExec(file, args, options);
  if (file === '/usr/bin/systemctl' && args[0] === 'start' && args[1] === 'servora-med.service') fire('target-started');
  return result;
};
const originalSpawn = cp.spawnSync;
cp.spawnSync = function(file, args, options) {
  if (point === 'backup-fail' && file === '/usr/bin/sudo' && args.at(-1) === 'backup') return {status: 1, stdout: '', stderr: ''};
  return originalSpawn(file, args, options);
};
syncBuiltinESMExports();
