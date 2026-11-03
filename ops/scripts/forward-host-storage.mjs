// Durable storage for the forward-only host adapter.
import {randomUUID, createHash} from 'node:crypto';
import {constants, openSync, closeSync, fstatSync, fsyncSync, lstatSync, readFileSync,
  readdirSync, writeFileSync, linkSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
const fail = code => { throw new Error(code); };
export const canonical = value => JSON.stringify(value) + '\n';
export function flushDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function trustedParents(path, uid = 0) {
  let at = '/';
  for (const part of dirname(path).split('/').filter(Boolean)) {
    at = join(at, part);
    const info = lstatSync(at);
    // /tmp is allowed only for a non-root unit-test store.
    if (!info.isDirectory() || info.isSymbolicLink() || (uid === 0 && (info.uid !== 0 || (info.mode & 0o022)))) fail('FORWARD_HOST_DIRECTORY_UNTRUSTED');
  }
}
export function protectedBytes(path, {uid = 0, gid = 0, mode = 0o600, links = 1, limit = 4 * 1024 * 1024} = {}) {
  trustedParents(path, uid);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || info.gid !== gid || info.nlink !== links
      || (info.mode & 0o7777) !== mode || info.size > limit) fail('FORWARD_HOST_FILE_UNTRUSTED');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function protectedJson(path, options) {
  const bytes = protectedBytes(path, options).toString('utf8');
  let record;
  try { record = JSON.parse(bytes); } catch { fail('FORWARD_HOST_RECORD_INVALID'); }
  if (canonical(record) !== bytes) fail('FORWARD_HOST_RECORD_INVALID');
  return record;
}
/** Exclusive named records fail closed if interrupted mid-write. They are
 * never replaced, truncated, silently repaired or used as resettable counters. */
export function publishExclusive(path, bytes, mode = 0o600) {
  trustedParents(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  flushDirectory(dirname(path));
}

export function openHostJournal(directory, {uid = 0, gid = 0} = {}) {
  const options = {uid, gid};
  const names = () => {
    trustedParents(directory + '/record', uid);
    const info = lstatSync(directory);
    if (info.uid !== uid || info.gid !== gid || (info.mode & 0o7777) !== 0o700) fail('FORWARD_HOST_DIRECTORY_UNTRUSTED');
    const entries = readdirSync(directory).sort();
    if (entries.some(name => !/^\d{4}\.json$/.test(name) && !/^\.publish-[0-9a-f-]{36}$/.test(name))) fail('FORWARD_HOST_JOURNAL_FOREIGN_ENTRY');
    return entries;
  };
  const inspect = () => {
    const entries = names(), finals = entries.filter(name => /^\d{4}\.json$/.test(name));
    if (finals.length > 512 || finals.some((name, i) => name !== String(i).padStart(4, '0') + '.json')) fail('FORWARD_HOST_JOURNAL_GAP');
    const temps = entries.filter(name => name.startsWith('.publish-'));
    const pairs = new Map();
    for (const name of finals) {
      const info = lstatSync(join(directory, name));
      const paired = temps.filter(temp => {
        const other = lstatSync(join(directory, temp));
        return other.dev === info.dev && other.ino === info.ino;
      });
      if (paired.length > 1 || info.nlink !== paired.length + 1) fail('FORWARD_HOST_JOURNAL_LINK_INVALID');
      pairs.set(name, paired);
    }
    const records = finals.map(name => protectedJson(join(directory, name), {...options, links: pairs.get(name).length + 1}));
    return {records, temps, pairs};
  };
  return {
    read: (validate = () => {}) => {
      const {records, temps, pairs} = inspect();
      validate(records);
      const paired = new Set([...pairs.values()].flat());
      const unpublished = temps.filter(name => !paired.has(name)).map(name => protectedJson(join(directory, name), options))
        .sort((a, b) => a.sequence - b.sequence);
      for (const record of unpublished) {
        const {hash, ...body} = record;
        if (hash !== createHash('sha256').update(canonical(body)).digest('hex')) fail('FORWARD_HOST_JOURNAL_INVALID');
      }
      validate([...records, ...unpublished]);
      return records;
    },
    pending: () => inspect().temps.length,
    append(record) {
      const final = join(directory, String(record.sequence).padStart(4, '0') + '.json');
      names();
      const temp = join(directory, '.publish-' + randomUUID());
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, canonical(record)); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, final); flushDirectory(directory); }
      catch (error) {
        if (error.code === 'EEXIST') { unlinkSync(temp); flushDirectory(directory); fail('FORWARD_HOST_JOURNAL_EXISTS'); }
        throw error;
      }
      unlinkSync(temp); flushDirectory(directory);
    },
    /** Only apply under the canonical lock may finish a fully written,
     * hash-valid next record. Read commands never call this method. */
    reconcile(validate) {
      const {records, temps, pairs} = inspect();
      const paired = new Set([...pairs.values()].flat());
      validate(records);
      for (const name of temps) {
        const path = join(directory, name);
        if (!paired.has(name)) {
          const record = protectedJson(path, options);
          validate([...records, record]);
          if (record.sequence !== records.length) fail('FORWARD_HOST_JOURNAL_CONFLICT');
          linkSync(path, join(directory, String(record.sequence).padStart(4, '0') + '.json'));
          flushDirectory(directory);
          records.push(record);
        }
        unlinkSync(path); flushDirectory(directory);
      }
    },
  };
}
