// Deterministic interruption harness. Loaded only by the isolated host test.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';

if (process.getuid() !== 0 || hostname() !== 'lima-servora-r4-20261012') {
  throw new Error('EMERGENCY_FAULT_ISOLATED_HOST_REQUIRED');
}
const point = process.env.SERVORA_EH_FAULT_POINT ?? '';
const fire = name => {
  if (point !== name) return;
  fs.writeSync(1, 'EMERGENCY_FAULT=' + name + '\n');
  process.kill(process.pid, 'SIGKILL');
};
const journalFinal = path => /\/emergency\/[0-9a-f-]{36}\/\d{4}\.json$/.test(path);

const unlink = fs.unlinkSync;
fs.unlinkSync = function (path, ...rest) {
  if (String(path).endsWith('/activation.block')) fire('barrier-unlink-before');
  if (String(path).endsWith('/90-servora-recovery.conf')) fire('policy-unlink-before');
  if (String(path).endsWith('/active.json')) fire('owner-unlink-before');
  const result = unlink.call(this, path, ...rest);
  if (String(path).endsWith('/activation.block')) fire('barrier-unlink-after');
  if (String(path).endsWith('/90-servora-recovery.conf')) fire('policy-unlink-after');
  if (String(path).endsWith('/active.json')) fire('owner-unlink-after');
  return result;
};

const link = fs.linkSync;
fs.linkSync = function (existing, target, ...rest) {
  if (String(target).endsWith('/receipt.json')) fire('receipt-link-before');
  if (journalFinal(String(target))) fire('journal-link-before');
  const result = link.call(this, existing, target, ...rest);
  if (String(target).endsWith('/receipt.json')) fire('receipt-link-after');
  if (journalFinal(String(target))) fire('journal-link-after');
  return result;
};

const fsync = fs.fsyncSync;
fs.fsyncSync = function (fd) {
  let path = null;
  try { path = fs.readlinkSync('/proc/self/fd/' + fd); } catch { /* best effort */ }
  if (path && /\/emergency\/[0-9a-f-]{36}\/\.[0-9a-f-]{36}\.tmp$/.test(path)) {
    const directory = path.slice(0, path.lastIndexOf('/'));
    const records = fs.readdirSync(directory).filter(name => /^\d{4}\.json$/.test(name)).sort();
    const phase = records.length
      ? JSON.parse(fs.readFileSync(directory + '/' + records.at(-1), 'utf8')).phase : null;
    if (!phase) fire('runtime-fsync');
    else if (phase === 'HANDOFF_COMPLETE' && !fs.existsSync(directory + '/receipt.json')) {
      fire('receipt-fsync');
    } else fire('journal-fsync');
  }
  if (path && path.endsWith('/runtime.json')) fire('runtime-fsync');
  if (path === '/var/lib/servora-med/deploy') fire('state-root-fsync');
  if (path === '/etc/systemd/system/servora-med.service.d') fire('policy-dir-fsync');
  return fsync(fd);
};

syncBuiltinESMExports();
