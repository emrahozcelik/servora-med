/** Read-only infrastructure time evidence. No domain TTLs or clock setters. */
import { readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const KEYS = ['formatVersion','source','bootId','timeNamespaceId','bootLowerMs',
  'bootUpperMs','wallAtUTC','wallResolutionMs','synchronization'];
const SYNC_KEYS = ['service','referenceAgeMs','rootDistanceMs','correctionMs','sourceCount'];
export const MAX_REFERENCE_AGE_MS = 768000; // Three maximum 256-second polls.
export const MAX_ROOT_DISTANCE_MS = 1000;
export const MAX_CORRECTION_MS = 100;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));

export function validateTimeEvidence(value) {
  if (!exact(value,KEYS) || value.formatVersion !== 1 || value.source !== 'linux-boottime'
    || typeof value.bootId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.bootId)
    || typeof value.timeNamespaceId !== 'string' || !/^time:\[[0-9]+\]$/.test(value.timeNamespaceId)
    || !Number.isSafeInteger(value.bootLowerMs) || value.bootLowerMs < 0
    || !Number.isSafeInteger(value.bootUpperMs) || value.bootUpperMs < value.bootLowerMs
    || value.wallResolutionMs !== 1 || typeof value.wallAtUTC !== 'string'
    || !Number.isFinite(Date.parse(value.wallAtUTC))
    || new Date(value.wallAtUTC).toISOString() !== value.wallAtUTC) throw new Error('TRUSTED_TIME_UNKNOWN');
  const sync = value.synchronization;
  if (!exact(sync,SYNC_KEYS) || sync.service !== 'chrony' || sync.sourceCount !== 2
    || !Number.isFinite(sync.referenceAgeMs) || sync.referenceAgeMs < 0 || sync.referenceAgeMs > MAX_REFERENCE_AGE_MS
    || !Number.isFinite(sync.rootDistanceMs) || sync.rootDistanceMs < 0 || sync.rootDistanceMs > MAX_ROOT_DISTANCE_MS
    || !Number.isFinite(sync.correctionMs) || Math.abs(sync.correctionMs) > MAX_CORRECTION_MS) {
    throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  return value;
}

/** Same-boot conservative bounds, including suspend; sufficient only to deny age. */
export function elapsedBootTime(event, current) {
  try { validateTimeEvidence(event); validateTimeEvidence(current); }
  catch { return {status:'UNKNOWN'}; }
  if (event.bootId !== current.bootId || event.timeNamespaceId !== current.timeNamespaceId
    || current.bootLowerMs < event.bootLowerMs || current.bootUpperMs < event.bootUpperMs) return {status:'UNKNOWN'};
  const lowerMs = Math.max(0,current.bootLowerMs-event.bootUpperMs);
  const upperMs = current.bootUpperMs-event.bootLowerMs;
  return {status:'KNOWN',lowerMs,upperMs};
}

/** UTC remains a veto for positive authority; boot bounds alone only deny. */
export function elapsedTime(event, current) {
  const bounds = elapsedBootTime(event,current);
  if (bounds.status !== 'KNOWN') return bounds;
  const {lowerMs,upperMs} = bounds;
  const wall = Date.parse(current.wallAtUTC)-Date.parse(event.wallAtUTC);
  if (wall+current.wallResolutionMs < lowerMs || wall-event.wallResolutionMs > upperMs) return {status:'UNKNOWN'};
  return {status:'KNOWN',lowerMs,upperMs};
}

/** chronyc 4.5 CSV; malformed, stale, local-reference or single-source is unknown. */
export function parseSynchronization(tracking, sources, nowMs) {
  const unknown = () => { throw new Error('TRUSTED_TIME_UNKNOWN'); };
  if (typeof tracking !== 'string' || typeof sources !== 'string' || !Number.isFinite(nowMs)) unknown();
  const fields = tracking.trim().split(',');
  const number = text => text?.trim() && Number.isFinite(Number(text)) ? Number(text) : NaN;
  if (fields.length !== 14 || !/^[0-9a-f]{8}$/i.test(fields[0]) || fields[0].toUpperCase() === '7F7F0101'
    || !Number.isInteger(number(fields[2])) || number(fields[2]) < 1 || number(fields[2]) > 15
    || fields[13] !== 'Normal' || !Number.isFinite(number(fields[10])) || number(fields[10]) < 0
    || !Number.isFinite(number(fields[11])) || number(fields[11]) < 0) unknown();
  const lines = sources.trim().split('\n').map(line => line.trim().split(','));
  const names = ['time.ume.tubitak.gov.tr','time.cloudflare.com'];
  if (lines.length !== 2 || lines.filter(line => line[1] === '*').length !== 1
    || !lines.some(line => line[1] === '*' && line[2] === fields[1])
    || lines.some(line => line.length !== 10 || line[0] !== '^' || !['*','+','-'].includes(line[1])
      || !names.includes(line[2]) || !Number.isInteger(number(line[3])) || number(line[3]) < 1 || number(line[3]) > 15
      || !Number.isInteger(number(line[4])) || number(line[4]) < 6 || number(line[4]) > 8
      || !/^[0-7]{1,3}$/.test(line[5]) || parseInt(line[5],8) === 0
      || !Number.isFinite(number(line[6])) || number(line[6]) < 0 || number(line[6])*1000 > MAX_REFERENCE_AGE_MS)
    || new Set(lines.map(line => line[2])).size !== 2) unknown();
  const synchronization = { service:'chrony', referenceAgeMs:nowMs-number(fields[3])*1000,
    rootDistanceMs:(number(fields[10])/2+number(fields[11]))*1000,
    correctionMs:number(fields[4])*1000, sourceCount:2 };
  // Share the exact metric bounds with persisted evidence validation.
  validateTimeEvidence({formatVersion:1,source:'linux-boottime',bootId:'00000000-0000-0000-0000-000000000000',
    timeNamespaceId:'time:[0]',bootLowerMs:0,bootUpperMs:0,wallAtUTC:new Date(nowMs).toISOString(),
    wallResolutionMs:1,synchronization});
  return synchronization;
}

export function evidenceFromLinuxReads(reads) {
  const uptime = text => {
    const first = typeof text === 'string' ? text.trim().split(/\s+/)[0] : '';
    if (!/^[0-9]+\.[0-9]{2}$/.test(first)) throw new Error('TRUSTED_TIME_UNKNOWN');
    const [seconds,fraction] = first.split('.');
    const ms = Number(seconds)*1000+Number(fraction)*10;
    if (!Number.isSafeInteger(ms)) throw new Error('TRUSTED_TIME_UNKNOWN');
    return ms;
  };
  if (!reads || reads.bootBefore !== reads.bootAfter || reads.namespaceBefore !== reads.namespaceAfter) {
    throw new Error('TRUSTED_TIME_UNKNOWN');
  }
  const before = uptime(reads.uptimeBefore), after = uptime(reads.uptimeAfter);
  if (after < before) throw new Error('TRUSTED_TIME_UNKNOWN');
  return validateTimeEvidence({formatVersion:1,source:'linux-boottime',bootId:reads.bootBefore,
    timeNamespaceId:reads.namespaceBefore,bootLowerMs:before,bootUpperMs:after+10,
    wallAtUTC:reads.wallAtUTC,wallResolutionMs:1,synchronization:reads.synchronization});
}

/** Fixed production paths/commands only. Never accepts caller clock overrides. */
export function sampleTrustedTime() {
  try {
    if (process.platform !== 'linux') throw new Error('TRUSTED_TIME_UNKNOWN');
    const run = (file,args) => execFileSync(file,args,{encoding:'utf8',timeout:2000,maxBuffer:16384,
      env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','pipe']}).trim();
    if (run('/usr/bin/systemctl',['is-active','chrony.service']) !== 'active') throw new Error('TRUSTED_TIME_UNKNOWN');
    // systemctl exits nonzero for an inactive unit. No service mutation is used.
    try {
      run('/usr/bin/systemctl',['is-active','systemd-timesyncd.service']);
      throw new Error('TRUSTED_TIME_UNKNOWN');
    } catch (error) {
      if (![3,4].includes(error.status) || !['inactive','failed'].includes(String(error.stdout).trim())) throw new Error('TRUSTED_TIME_UNKNOWN');
    }
    const bootBefore = readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    const namespaceBefore = readlinkSync('/proc/self/ns/time');
    if (!/^monotonic\s+0\s+0\s+boottime\s+0\s+0\s*$/.test(readFileSync('/proc/self/timens_offsets','utf8').trim())) {
      throw new Error('TRUSTED_TIME_UNKNOWN');
    }
    const uptimeBefore = readFileSync('/proc/uptime','utf8');
    const tracking = run('/usr/bin/chronyc',['-N','-c','tracking']);
    const sources = run('/usr/bin/chronyc',['-N','-c','sources']);
    const wallAtUTC = new Date().toISOString();
    const synchronization = parseSynchronization(tracking,sources,Date.parse(wallAtUTC));
    return evidenceFromLinuxReads({bootBefore,namespaceBefore,uptimeBefore,wallAtUTC,synchronization,
      uptimeAfter:readFileSync('/proc/uptime','utf8'),
      bootAfter:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),namespaceAfter:readlinkSync('/proc/self/ns/time')});
  } catch { throw new Error('TRUSTED_TIME_UNKNOWN'); }
}
